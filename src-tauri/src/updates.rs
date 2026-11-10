// In-app updates: the installed app checks GitHub for a newer signed build and
// installs it itself, so nobody has to download a new setup.exe by hand.
//
// The manifest is latest.json on the rolling "latest" release (see
// .github/workflows/windows-build.yml and docs/updates.md). Every update is
// signed by the project's updater key; the public half is in tauri.conf.json,
// so the app refuses any installer that key did not sign.
//
// The Bridge drives this through three commands: `update_check`,
// `update_install` and `update_status` (polled for progress). Handover on
// install: download and verify first, then stop the core (the database stays in
// the data folder, untouched by the installer), then the installer replaces the
// app files and starts the new version, whose core resumes any interrupted run.
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

// The repo can be private. Then GitHub answers only with a read token, which you
// paste once in Systems > Updates. It is kept in the data folder (updater-token),
// on this PC only, never in the database or the event log, and is sent only to
// GitHub (the download's redirect to GitHub's file storage drops it).
const TOKEN_FILE: &str = "updater-token";

fn token_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    crate::data_dir(app).join(TOKEN_FILE)
}

fn token(app: &tauri::AppHandle) -> Option<String> {
    std::fs::read_to_string(token_path(app)).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

/// The updater, with the token when there is one. The manifest is read through
/// GitHub's contents API as raw JSON; the installer through the release asset API.
fn updater(app: &tauri::AppHandle) -> Result<Updater, tauri_plugin_updater::Error> {
    let mut b = app.updater_builder().header("Accept", "application/vnd.github.raw+json")?;
    if let Some(t) = token(app) {
        b = b.header("Authorization", format!("Bearer {t}"))?;
    }
    b.build()
}

#[derive(Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// idle | checking | current | available | downloading | installing | error
    phase: String,
    current: String,
    version: Option<String>,
    notes: Option<String>,
    date: Option<String>,
    downloaded: u64,
    total: Option<u64>,
    error: Option<String>,
    checked_at: Option<String>,
}

#[derive(Default)]
pub struct Updates {
    status: Mutex<UpdateStatus>,
    pending: Mutex<Option<Update>>,
}

fn now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    secs.to_string()
}

fn set(app: &tauri::AppHandle, f: impl FnOnce(&mut UpdateStatus)) -> UpdateStatus {
    let st = app.state::<Updates>();
    let mut s = st.status.lock().unwrap();
    f(&mut s);
    s.clone()
}

/// Turn updater errors into a sentence a person can act on.
fn explain(e: &tauri_plugin_updater::Error) -> String {
    let raw = e.to_string();
    if raw.contains("signature") || raw.contains("Signature") {
        format!("The download did not carry a valid SoftwareFactory signature, so it was not installed ({raw}).")
    } else if raw.contains("error sending request") || raw.contains("dns") || raw.contains("connect") {
        "Could not reach GitHub to look for updates. Check the internet connection and try again.".into()
    } else if raw.contains("401") || raw.contains("403") || raw.contains("404") || raw.contains("Could not fetch a valid release JSON") {
        "GitHub did not show the update information. If the repo is private, add a read token below (or check that it has not expired). If it is public, the next build of main publishes it.".into()
    } else {
        raw
    }
}

#[tauri::command]
pub fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn update_status(app: tauri::AppHandle) -> UpdateStatus {
    let current = app.package_info().version.to_string();
    set(&app, |s| s.current = current)
}

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> UpdateStatus {
    let current = app.package_info().version.to_string();
    {
        let s = app.state::<Updates>();
        let busy = matches!(s.status.lock().unwrap().phase.as_str(), "downloading" | "installing");
        if busy {
            return update_status(app.clone());
        }
    }
    set(&app, |s| {
        s.phase = "checking".into();
        s.current = current.clone();
        s.error = None;
    });
    let result = match updater(&app) {
        Ok(u) => u.check().await,
        Err(e) => Err(e),
    };
    let checked = now();
    match result {
        Ok(Some(update)) => {
            let st = set(&app, |s| {
                s.phase = "available".into();
                s.version = Some(update.version.clone());
                s.notes = update.body.clone();
                s.date = update.date.map(|d| d.to_string());
                s.checked_at = Some(checked);
                s.downloaded = 0;
                s.total = None;
            });
            *app.state::<Updates>().pending.lock().unwrap() = Some(update);
            st
        }
        Ok(None) => set(&app, |s| {
            s.phase = "current".into();
            s.version = None;
            s.notes = None;
            s.checked_at = Some(checked);
        }),
        Err(e) => set(&app, |s| {
            s.phase = "error".into();
            s.error = Some(explain(&e));
            s.checked_at = Some(checked);
        }),
    }
}

/// Download, verify, stop the core, then hand over to the installer (the app exits here on success).
#[tauri::command]
pub async fn update_install(app: tauri::AppHandle) -> UpdateStatus {
    let pending = app.state::<Updates>().pending.lock().unwrap().clone();
    let Some(mut update) = pending else {
        return set(&app, |s| {
            s.phase = "error".into();
            s.error = Some("There is no update to install. Press Check for updates first.".into());
        });
    };
    set(&app, |s| {
        s.phase = "downloading".into();
        s.downloaded = 0;
        s.total = None;
        s.error = None;
    });
    // The release asset API returns the file itself only for this Accept header.
    update.headers.insert("Accept", "application/octet-stream".parse().unwrap());
    let progress = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                set(&progress, |s| {
                    s.downloaded += chunk as u64;
                    s.total = total;
                });
            },
            || {},
        )
        .await;
    let bytes = match bytes {
        Ok(b) => b,
        Err(e) => {
            return set(&app, |s| {
                s.phase = "error".into();
                s.error = Some(explain(&e));
            })
        }
    };
    set(&app, |s| s.phase = "installing".into());
    // Give the Bridge a moment to show "Installing" before the window goes away.
    std::thread::sleep(std::time::Duration::from_millis(400));
    crate::stop_core(&app);
    // On Windows this starts the installer (passive: a small progress window, no questions)
    // and exits; the installer starts the new version when it is done.
    match update.install(bytes) {
        Ok(()) => {
            // Platforms where install returns: start the new version ourselves.
            app.restart();
        }
        Err(e) => {
            crate::start_core(&app);
            set(&app, |s| {
                s.phase = "error".into();
                s.error = Some(format!("The installer could not start, so the current version keeps running: {}", explain(&e)));
            })
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenState {
    set: bool,
    /// The first and last characters, so you can tell which token it is.
    hint: Option<String>,
}

fn token_state(app: &tauri::AppHandle) -> TokenState {
    let t = token(app);
    TokenState {
        set: t.is_some(),
        hint: t.map(|t| if t.len() > 12 { format!("{}…{}", &t[..8], &t[t.len() - 4..]) } else { "saved".into() }),
    }
}

#[tauri::command]
pub fn update_token_status(app: tauri::AppHandle) -> TokenState {
    token_state(&app)
}

/// Save (or, with an empty token, remove) the GitHub read token for a private repo.
#[tauri::command]
pub fn update_token_set(app: tauri::AppHandle, token: String) -> Result<TokenState, String> {
    let path = token_path(&app);
    let t = token.trim();
    if t.is_empty() {
        let _ = std::fs::remove_file(&path);
    } else {
        if t.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err("That does not look like a GitHub token (it has spaces in it).".into());
        }
        std::fs::create_dir_all(crate::data_dir(&app)).map_err(|e| e.to_string())?;
        std::fs::write(&path, t).map_err(|e| format!("Could not save the token: {e}"))?;
    }
    Ok(token_state(&app))
}
