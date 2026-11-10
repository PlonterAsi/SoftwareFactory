// SoftwareFactory desktop shell.
//
// The shell stays thin on purpose: it opens the Bridge window and runs the
// TypeScript core as a child process on 127.0.0.1:4317. Rust grows here only
// where profiling says it pays (see the plan, "Tech stack").
//
// The installer ships its own Node.js (resources/node/node.exe), so a fresh
// Windows PC needs nothing else to start the app. The core's output goes to
// core.log in the data folder, and the Bridge can ask why the core is down
// (`core_status`) or start it again (`restart_core`).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

#[derive(Default)]
struct CoreState {
    child: Option<Child>,
    error: Option<String>,
    node: String,
    entry: String,
    bundled_node: bool,
}

struct Core(Mutex<CoreState>);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreStatus {
    running: bool,
    error: Option<String>,
    node: String,
    entry: String,
    log: String,
    log_tail: String,
    data_dir: String,
    bundled_node: bool,
}

/// Strip the Windows verbatim prefix (`\\?\`) so Node sees a normal path.
fn plain(p: PathBuf) -> PathBuf {
    let stripped = p
        .to_str()
        .and_then(|s| s.strip_prefix(r"\\?\"))
        .filter(|rest| !rest.starts_with("UNC"))
        .map(PathBuf::from);
    stripped.unwrap_or(p)
}

/// Folders where a bundled resource may be: the installer's resource dir, or
/// next to the exe (the portable zip).
fn resource_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        dirs.push(plain(dir));
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(PathBuf::from)) {
        dirs.push(plain(dir));
    }
    dirs
}

/// Where the compiled core lives. Override with SF_CORE_ENTRY.
/// An installed app ships it as a bundled resource; a dev build uses the repo copy.
fn core_entry(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("SF_CORE_ENTRY") {
        return PathBuf::from(p);
    }
    for dir in resource_dirs(app) {
        let bundled = dir.join("core").join("server.js");
        if bundled.exists() {
            return bundled;
        }
    }
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../packages/core/dist/server.js"))
}

/// The Node.js that runs the core: SF_NODE, else the one shipped with the app, else `node` on PATH.
fn node_bin(app: &tauri::AppHandle) -> (String, bool) {
    if let Ok(p) = std::env::var("SF_NODE") {
        return (p, false);
    }
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    for dir in resource_dirs(app) {
        let p = dir.join("node").join(exe);
        if p.is_file() {
            return (p.to_string_lossy().into_owned(), true);
        }
    }
    ("node".into(), false)
}

/// Find Claude Code in a form the core can spawn directly, as (env var, path).
/// The native install is `claude.exe`. An npm install on Windows is a `claude.cmd`
/// shim that cannot be spawned, so its `cli.js` is run with Node instead.
fn find_claude() -> Option<(&'static str, PathBuf)> {
    if let Ok(p) = std::env::var("SF_CLAUDE_BIN") {
        return Some(("SF_CLAUDE_BIN", PathBuf::from(p)));
    }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        dirs.push(PathBuf::from(&home).join(".local").join("bin"));
        dirs.push(PathBuf::from(&home).join(".claude").join("local"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
    if let Some(p) = dirs.iter().map(|d| d.join(exe)).find(|p| p.is_file()) {
        return Some(("SF_CLAUDE_BIN", p));
    }
    dirs.iter()
        .filter(|d| d.join("claude.cmd").is_file())
        .map(|d| d.join("node_modules").join("@anthropic-ai").join("claude-code").join("cli.js"))
        .find(|p| p.is_file())
        .map(|p| ("SF_CLAUDE_JS", p))
}

fn data_dir(app: &tauri::AppHandle) -> PathBuf {
    plain(app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn log_path(app: &tauri::AppHandle) -> PathBuf {
    data_dir(app).join("core.log")
}

/// Start the core (stopping any earlier one) and record how it went.
fn start_core(app: &tauri::AppHandle) {
    let state = app.state::<Core>();
    let mut st = state.0.lock().unwrap();
    if let Some(mut old) = st.child.take() {
        let _ = old.kill();
        let _ = old.wait();
    }
    let dir = data_dir(app);
    let (node, bundled) = node_bin(app);
    let entry = core_entry(app);
    st.node = node.clone();
    st.bundled_node = bundled;
    st.entry = entry.to_string_lossy().into_owned();
    st.error = None;
    if let Err(e) = std::fs::create_dir_all(&dir) {
        st.error = Some(format!("Could not create the data folder {}: {e}", dir.display()));
        return;
    }
    // core.log keeps the last start's output (a fresh file each start, the previous one kept as core.prev.log).
    let log = log_path(app);
    let _ = std::fs::rename(&log, dir.join("core.prev.log"));
    let (out, err) = match File::create(&log).and_then(|f| Ok((f.try_clone()?, f))) {
        Ok((a, b)) => (Stdio::from(a), Stdio::from(b)),
        Err(_) => (Stdio::null(), Stdio::null()),
    };
    let mut cmd = Command::new(&node);
    // SF_PARENT_PID: the core exits on its own when this shell is gone, however it went
    // (window closed, crash, Task Manager), so no orphan core keeps port 4317 busy.
    cmd.arg(&entry).current_dir(&dir).env("SF_DB", dir.join("factory.db")).env("SF_PARENT_PID", std::process::id().to_string()).stdout(out).stderr(err).stdin(Stdio::null());
    // Real agents when Claude Code is installed; otherwise the free practice crew.
    // A crew picked in the Bridge is remembered in the database and wins over this.
    let runtime = match (std::env::var("SF_RUNTIME"), find_claude()) {
        (Ok(r), claude) => {
            if let Some((key, path)) = claude {
                cmd.env(key, path);
            }
            r
        }
        (Err(_), Some((key, path))) => {
            cmd.env(key, path);
            "claude-code".into()
        }
        (Err(_), None) => "mock".into(),
    };
    cmd.env("SF_RUNTIME", runtime);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.spawn() {
        Ok(child) => st.child = Some(child),
        Err(e) => {
            let msg = if e.kind() == std::io::ErrorKind::NotFound {
                format!("Node.js was not found ({node}). This build needs Node.js 22.5 or newer, or the installer that ships it.")
            } else {
                format!("Could not start the core with {node}: {e}")
            };
            if let Ok(mut f) = OpenOptions::new().append(true).create(true).open(&log) {
                let _ = writeln!(f, "{msg}");
            }
            st.error = Some(msg);
        }
    }
}

/// The last few KB of core.log.
fn log_tail(path: &PathBuf) -> String {
    let Ok(mut f) = File::open(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(4000)));
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

fn status(app: &tauri::AppHandle) -> CoreStatus {
    let state = app.state::<Core>();
    let mut st = state.0.lock().unwrap();
    let mut error = st.error.clone();
    let running = match st.child.as_mut().map(|c| c.try_wait()) {
        Some(Ok(None)) => true,
        Some(Ok(Some(code))) => {
            error.get_or_insert(format!("The core stopped ({code}). Its last words are in the details below."));
            false
        }
        _ => false,
    };
    let log = log_path(app);
    CoreStatus {
        running,
        error,
        node: st.node.clone(),
        entry: st.entry.clone(),
        log_tail: log_tail(&log),
        log: log.to_string_lossy().into_owned(),
        data_dir: data_dir(app).to_string_lossy().into_owned(),
        bundled_node: st.bundled_node,
    }
}

#[tauri::command]
fn core_status(app: tauri::AppHandle) -> CoreStatus {
    status(&app)
}

#[tauri::command]
fn restart_core(app: tauri::AppHandle) -> CoreStatus {
    start_core(&app);
    std::thread::sleep(std::time::Duration::from_millis(600));
    status(&app)
}

fn main() {
    tauri::Builder::default()
        .manage(Core(Mutex::new(CoreState::default())))
        .invoke_handler(tauri::generate_handler![core_status, restart_core])
        .setup(|app| {
            start_core(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building SoftwareFactory")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = app.state::<Core>().0.lock().unwrap().child.take() {
                    let _ = child.kill();
                }
            }
        });
}
