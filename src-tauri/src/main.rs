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

/// Where the compiled core lives. Override with SF_CORE_ENTRY.
fn core_entry() -> PathBuf {
    std::env::var("SF_CORE_ENTRY")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../packages/core/dist/server.js")))
}

fn start_core(data_dir: PathBuf) -> std::io::Result<Child> {
    std::fs::create_dir_all(&data_dir)?;
    let node = std::env::var("SF_NODE").unwrap_or_else(|_| "node".into());
    Command::new(node)
        .arg(core_entry())
        .env("SF_DB", data_dir.join("factory.db"))
        .env("SF_RUNTIME", std::env::var("SF_RUNTIME").unwrap_or_else(|_| "claude-code".into()))
        .spawn()
}

fn main() {
    tauri::Builder::default()
        .manage(Core(Mutex::new(None)))
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            match start_core(data_dir) {
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
