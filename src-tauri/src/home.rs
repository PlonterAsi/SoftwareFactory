// The home screen inside the app window.
//
// The fenced path (packages/core/src/fence, docs/fence.md) serves its home screen on 127.0.0.1:4517. Here the
// shell starts it and its watchdog as hidden processes on the bundled Node.js, and shows the screen in the app's
// own window: no console window and no starter file.
//
// - The home screen prints its address, with a pass that works once, on its output. The shell reads that line,
//   opens the address in the window, and keeps the pass out of the log.
// - The shell holds a pipe to the home screen. When the window is closed, or the shell is gone for any reason,
//   the pipe ends and the home screen says goodbye by itself (a run in the room is stopped, the watchdog is told).
// - If the home screen stops by itself, the shell starts it again once. A second stop is shown in the window.
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

#[derive(Default)]
pub struct HomeState {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    watchdog: Option<Child>,
    closing: bool,
    restarts: u32,
    started: Option<Instant>,
    /// The window's first page has loaded, so it can be sent on to the home screen.
    ready: bool,
    /// An address that arrived before the window was ready.
    pending: Option<String>,
}

pub struct Home(pub Mutex<HomeState>);

const URL_LINE: &str = "SoftwareFactory home screen: ";

/// The folder the fenced path keeps its record and settings in (the same one the command line uses).
fn work_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    base.join("SoftwareFactoryStep1")
}

fn read_json(name: &str) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(work_dir().join(name)).ok()?;
    serde_json::from_str(&text).ok()
}

/// A ticket is being worked right now (from the home screen's sign of life).
pub fn working() -> bool {
    read_json("alive.json").map(|v| !v["running"].is_null() && v["closed"] != true).unwrap_or(false)
}

/// Updates install themselves at start unless the setting says no.
pub fn auto_update_on() -> bool {
    read_json("settings.json").map(|v| v["autoUpdate"] != false).unwrap_or(true)
}

fn node_cmd(app: &tauri::AppHandle, args: &[&str]) -> Command {
    let (node, _) = crate::node_bin(app);
    let entry = crate::core_entry(app).with_file_name("step1-cli.js");
    let mut cmd = Command::new(node);
    cmd.arg(entry).args(args).current_dir(crate::data_dir(app));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn js_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into())
}

/// Say something in the window: on the starting page in its own place, on any other page instead of it.
fn show(app: &tauri::AppHandle, text: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let t = js_string(text);
        let js = format!("(function(){{var e=document.getElementById('sf-starting');if(e){{e.textContent={t};}}else{{document.title='SoftwareFactory';document.body.textContent={t};}}}})()");
        let _ = w.eval(js.as_str());
    }
}

fn go(app: &tauri::AppHandle, url: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let js = format!("window.location.replace({})", js_string(url));
        let _ = w.eval(js.as_str());
    }
}

/// The window finished loading a page. The first time, an address that was waiting is opened.
pub fn page_ready(app: &tauri::AppHandle) {
    let url = {
        let state = app.state::<Home>();
        let mut st = state.0.lock().unwrap();
        st.ready = true;
        st.pending.take()
    };
    if let Some(url) = url {
        go(app, &url);
    }
}

fn open(app: &tauri::AppHandle, url: &str) {
    let now = {
        let state = app.state::<Home>();
        let mut st = state.0.lock().unwrap();
        if st.ready {
            true
        } else {
            st.pending = Some(url.to_string());
            false
        }
    };
    if now {
        go(app, url);
    }
}

fn append(path: &PathBuf) -> Option<File> {
    OpenOptions::new().append(true).create(true).open(path).ok()
}

fn out_to(path: &PathBuf) -> Stdio {
    append(path).map(Stdio::from).unwrap_or_else(Stdio::null)
}

/// Start the watchdog (when none of ours is watching) and the home screen.
pub fn start(app: &tauri::AppHandle) {
    let dir = crate::data_dir(app);
    let _ = std::fs::create_dir_all(&dir);
    let log = dir.join("home.log");
    let state = app.state::<Home>();
    let mut st = state.0.lock().unwrap();
    st.closing = false;
    // The watchdog keeps to one at a time by itself, and goes home by itself when SoftwareFactory is closed.
    let watching = st.watchdog.as_mut().map(|c| matches!(c.try_wait(), Ok(None))).unwrap_or(false);
    if !watching {
        let wlog = dir.join("watchdog.log");
        let _ = File::create(&wlog);
        st.watchdog = node_cmd(app, &["watchdog"]).stdin(Stdio::null()).stdout(out_to(&wlog)).stderr(out_to(&wlog)).spawn().ok();
    }
    // home.log keeps the last start (the one before it as home.prev.log).
    let _ = std::fs::rename(&log, dir.join("home.prev.log"));
    let _ = File::create(&log);
    let mut cmd = node_cmd(app, &["home", "--no-open"]);
    cmd.env("SF_SHELL", "1").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(out_to(&log));
    match cmd.spawn() {
        Ok(mut child) => {
            let out = child.stdout.take();
            st.stdin = child.stdin.take();
            st.child = Some(child);
            st.started = Some(Instant::now());
            drop(st);
            if let Some(out) = out {
                let app = app.clone();
                std::thread::spawn(move || follow(app, out, log));
            }
        }
        Err(e) => {
            drop(st);
            show(app, &format!("SoftwareFactory could not start its home screen: {e}"));
        }
    }
}

/// Read what the home screen says until it is gone; then start it again once, or say that it stopped.
fn follow(app: tauri::AppHandle, out: ChildStdout, log: PathBuf) {
    let mut file = append(&log);
    for line in BufReader::new(out).lines().map_while(Result::ok) {
        if let Some(url) = line.strip_prefix(URL_LINE) {
            if let Some(f) = file.as_mut() {
                let _ = writeln!(f, "{URL_LINE}opened in the app window");
            }
            open(&app, url.trim());
        } else if let Some(f) = file.as_mut() {
            let _ = writeln!(f, "{line}");
        }
    }
    drop(file);
    let state = app.state::<Home>();
    let mut st = state.0.lock().unwrap();
    if st.closing {
        return;
    }
    let ended = st.child.as_mut().and_then(|c| c.wait().ok()).map(|s| s.to_string()).unwrap_or_else(|| "no exit code".into());
    st.child = None;
    st.stdin = None;
    // A start that held for five minutes was a good start: the next stop gets its own restart.
    if st.started.map(|t| t.elapsed() > Duration::from_secs(300)).unwrap_or(false) {
        st.restarts = 0;
    }
    let again = st.restarts < 1;
    if again {
        st.restarts += 1;
    }
    drop(st);
    if again {
        std::thread::sleep(Duration::from_millis(1500));
        if !app.state::<Home>().0.lock().unwrap().closing {
            start(&app);
        }
    } else {
        let tail = crate::log_tail(&log);
        show(&app, &format!("SoftwareFactory's home screen stopped ({ended}) and stopped again after one restart.\n\n{}\n\nClose this window and open SoftwareFactory again. The details are in {}", tail.trim(), log.display()));
    }
}

/// Close the home screen: end the pipe so it says goodbye by itself, wait a little, then make sure it is gone.
pub fn stop(app: &tauri::AppHandle) {
    let (child, stdin) = {
        let state = app.state::<Home>();
        let mut st = state.0.lock().unwrap();
        st.closing = true;
        // The watchdog is left to go home by itself: it reads the goodbye and ends anything left in the room.
        st.watchdog = None;
        (st.child.take(), st.stdin.take())
    };
    drop(stdin);
    if let Some(mut c) = child {
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(8) {
            if let Ok(Some(_)) = c.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        crate::kill_tree(&mut c);
    }
}
