# In-app updates

The installed app updates itself. Nobody downloads a new setup.exe after the first install.

## What you see

- **Top bar:** the version chip (`v0.2.41`). It lights up and shows `v0.2.41 → v0.2.44` when a newer version is ready.
- **Systems → Updates:** the current version, when it last checked, **Check for updates**, **Install vX now**, a download progress bar, the setting *Install updates by themselves when the factory is idle* (on by default), and the list of versions this install has run.
- **A strip under the top bar** while an update counts down (15 s, with *Update now* and *Not now*), waits for a running build to finish, downloads, or installs.

## When it updates

1. The app checks 5 seconds after the window opens, then every 6 hours, and whenever you press Check for updates.
2. With the automatic setting on and no build running, it counts down 15 seconds and installs. *Not now* skips that version until the next launch.
3. If a build is running, it waits until the factory is idle. *Install now* is still there: the run is cut and resumes from its last finished station when the new version starts.
4. With the setting off, nothing installs until you press Install.

## The handover

1. Download and verify. The installer must carry a signature from the SoftwareFactory updater key. The public half is in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`), and anything else is refused.
2. Stop the core. The database (`factory.db`), projects and settings stay in the data folder (`%APPDATA%\dev.plonter.softwarefactory`). The installer does not touch that folder.
3. Run the installer in passive mode: a small progress window, no questions, no admin prompt (it is a per-user install).
4. The installer starts the new version. Its core upgrades the database if the schema moved (with a backup first, see [storage.md](storage.md)), records `app.updated` (from, to) in the `app_versions` table, and resumes any run the update cut.

## Where updates come from

Every merge to main runs `.github/workflows/windows-build.yml`:

- The build gets its own version, `0.2.<workflow run number>`, so every build is newer than the one before.
- With the `TAURI_SIGNING_PRIVATE_KEY` repository secret set, the installer is signed for the updater. CI checks the signature against the public key in `tauri.conf.json` (`scripts/updates/verify-sig.mjs`), so a mismatched secret fails the build and never ships an update nobody can install.
- After the smoke test passes, the `latest` release gets `latest.json` (`scripts/updates/manifest.mjs`). Installed apps read it from `https://github.com/PlonterAsi/SoftwareFactory/releases/download/latest/latest.json`.
- Without the secret, builds still publish installers, but no `latest.json`, so no update is offered (a warning on the run says so).

This updater signature is free and separate from Windows code signing. The installer is still not code-signed, so SmartScreen warns on a first manual install. Updates through the app do not go through SmartScreen.

## How it is tested

The Windows smoke test (`scripts/smoke/windows-smoke.mjs`, step 9) proves the whole path on every build:

1. CI builds the same app a second time as version `0.0.1`. That build looks for updates on the test's own local server and trusts a throwaway key made in that CI run. The build is never published.
2. CI signs the real installer with the throwaway key.
3. The test installs `0.0.1`, launches it, and writes a note. Then it waits: the old app must find the update by itself, count down, download it, close itself and its core, install it, and start again as the new version.
4. The note, the version history and the database health are checked on the new version.

## The updater key

- The public key is committed in `src-tauri/tauri.conf.json`.
- The private key is the `TAURI_SIGNING_PRIVATE_KEY` repository secret. It has no password, so `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` stays unset. Keep an offline copy: if the key is lost, installed apps can no longer verify updates, and everyone needs one manual install of a build with a new public key.
- To rotate the key: generate a new pair with `npx tauri signer generate --ci -p "" -w softwarefactory-updater.key`, put the new public key in `tauri.conf.json`, and set the secret. Apps installed before the rotation need one manual install.
