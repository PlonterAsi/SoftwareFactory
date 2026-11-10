// SoftwareFactory desktop shell.
//
// The shell stays thin on purpose: it opens the Bridge window and runs the
// TypeScript core as a child process on 127.0.0.1:4317. Rust grows here only
// where profiling says it pays (see the plan, "Tech stack").
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

struct Core(Mutex<Option<Child>>);

/// Strip the Windows verbatim prefix (`\\?\`) so Node sees a normal path.
fn plain(p: PathBuf) -> PathBuf {
    let stripped = p
        .to_str()
        .and_then(|s| s.strip_prefix(r"\\?\"))
        .filter(|rest| !rest.starts_with("UNC"))
        .map(PathBuf::from);
    stripped.unwrap_or(p)
}

/// Where the compiled core lives. Override with SF_CORE_ENTRY.
/// An installed app ships it as a bundled resource; a dev build uses the repo copy.
fn core_entry(app: &tauri::App) -> PathBuf {
    if let Ok(p) = std::env::var("SF_CORE_ENTRY") {
        return PathBuf::from(p);
    }
    if let Ok(dir) = app.path().resource_dir() {
        let bundled = plain(dir.join("core").join("server.js"));
        if bundled.exists() {
            return bundled;
        }
    }
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../packages/core/dist/server.js"))
}

/// Find a Claude Code binary that can be spawned directly. On Windows the npm
/// shim (`claude.cmd`) cannot be, so look for the native `claude.exe`.
fn find_claude() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("SF_CLAUDE_BIN") {
        return Some(PathBuf::from(p));
    }
    let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        dirs.push(PathBuf::from(home).join(".local").join("bin"));
    }
    dirs.into_iter().map(|d| d.join(exe)).find(|p| p.is_file())
}

fn start_core(app: &tauri::App, data_dir: PathBuf) -> std::io::Result<Child> {
    let data_dir = plain(data_dir);
    std::fs::create_dir_all(&data_dir)?;
    let node = std::env::var("SF_NODE").unwrap_or_else(|_| "node".into());
    let mut cmd = Command::new(node);
    cmd.arg(core_entry(app)).current_dir(&data_dir).env("SF_DB", data_dir.join("factory.db"));
    // Real agents when Claude Code is installed; otherwise the free mock crew.
    let runtime = match (std::env::var("SF_RUNTIME"), find_claude()) {
        (Ok(r), claude) => {
            if let Some(c) = claude { cmd.env("SF_CLAUDE_BIN", c); }
            r
        }
        (Err(_), Some(c)) => {
            cmd.env("SF_CLAUDE_BIN", c);
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
    cmd.spawn()
}

fn main() {
    tauri::Builder::default()
        .manage(Core(Mutex::new(None)))
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            match start_core(app, data_dir) {
                Ok(child) => *app.state::<Core>().0.lock().unwrap() = Some(child),
                Err(e) => eprintln!("SoftwareFactory: could not start the core: {e}"),
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building SoftwareFactory")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = app.state::<Core>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
