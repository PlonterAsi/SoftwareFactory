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
- After the smoke test passes, the installers go to the `latest` release, and `latest.json` (`scripts/updates/manifest.mjs`) is force-pushed to the `updates` branch. Installed apps read it through GitHub's API (`/repos/PlonterAsi/SoftwareFactory/contents/latest.json?ref=updates`), and download the installer through the release asset API.
- Without the secret, builds still publish installers, but no `latest.json`, so no update is offered (a warning on the run says so).

This updater signature is free and separate from Windows code signing. The installer is still not code-signed, so SmartScreen warns on a first manual install. Updates through the app do not go through SmartScreen.

## How it is tested

The Windows smoke test (`scripts/smoke/windows-smoke.mjs`, step 9) proves the whole path on every build:

1. CI builds the same app a second time as version `0.0.1`. That build looks for updates on the test's own local server and trusts a throwaway key made in that CI run. The build is never published.
2. CI signs the real installer with the throwaway key.
3. The test installs `0.0.1`, launches it, and writes a note. Then it waits: the old app must find the update by itself, count down, download it, close itself and its core, install it, and start again as the new version.
4. The note, the version history and the database health are checked on the new version.

## Private repo

The repo can be private. GitHub then shows the manifest and the installer only with a token, so each PC needs one:

1. On github.com: Settings, Developer settings, Personal access tokens, Fine-grained tokens, Generate new token.
2. Repository access: only `SoftwareFactory`. Permissions: Contents, Read-only. Choose an expiry you are happy with.
3. In the app: Systems, Updates, GitHub access, Add token, paste, Save and check.

The token is kept in `updater-token` in the data folder. It stays on that PC only and never goes into the database or the event log. It is sent only to GitHub, and the download's redirect to GitHub's file storage drops it. When it expires, Updates says GitHub did not show the update information. Paste a new one.

A private repo also means GitHub Actions minutes count: 2,000 a month free, and Windows runners use them at double rate. A self-hosted Windows runner is free. The smoke test installs and uninstalls the app and wipes its data folder, so it must not run under your everyday Windows account.

## The updater key

- The public key is committed in `src-tauri/tauri.conf.json`.
- The private key is the `TAURI_SIGNING_PRIVATE_KEY` repository secret. It has no password, so `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` stays unset. Keep an offline copy: if the key is lost, installed apps can no longer verify updates, and everyone needs one manual install of a build with a new public key.
- To rotate the key: generate a new pair with `npx tauri signer generate --ci -p "" -w softwarefactory-updater.key`, put the new public key in `tauri.conf.json`, and set the secret. Apps installed before the rotation need one manual install.
