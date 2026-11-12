# Dogfooding SoftwareFactory

Any Claude thread that works on SoftwareFactory judges the product by using it the way Assaf does: the installed app on his PC, with his real data. A green CI run is not the same as "it works for Assaf".

## The loop

1. **Check the installed version.** `curl -s 127.0.0.1:4317/api/health` gives `appVersion` and `activeRuns`. Compare with `gh release view latest -R PlonterAsi/SoftwareFactory`. Update history is in the `app_versions` table of `%APPDATA%\dev.plonter.softwarefactory\factory.db` (read it, never write it by hand).
2. **See what he sees.** `powershell -ExecutionPolicy Bypass -File scripts/dogfood/window-shot.ps1 <out.png>` saves a screenshot of the real SoftwareFactory window (it reads the window, it clicks nothing).
3. **Use the same UI against his real core.** `npm ci`, then `npm run dev -w @sf/bridge` and open `http://localhost:5173` in the browser pane. Vite proxies `/api` to the running app's core on port 4317, so this is his data with the Bridge from your branch. View choices (layout and so on) live in that browser's storage, not in his app.
4. **Write down every friction point** as you hit it: what you tried, what happened, what you expected.
5. **Log each one in SoftwareFactory.** Until tickets land on main, a friction point is a note captured in the project "UI/UX improvement of SoftwareFactory" (open it, type in the Assistant box, press Capture: free, no AI call). When tickets are on main, use a ticket instead.
6. **Fix the smallest ones in a PR**, check them in the browser pane against the real core, merge after CI is green. The app updates itself within minutes of the next window open (see [updates.md](updates.md)).
7. **Re-run step 2 after the update** to confirm he now sees the fix.

## Rules

- Never delete user data. Anything that changes his data (merging projects, archiving, starting a paid run) waits for Assaf's go-ahead in the thread, even if it is one click in the app.
- Reads are free: health, project lists, screenshots, the database read-only.
- A practice run costs nothing; a real run spends his Claude budget. Do not start real runs to test.

## Log

- 2026-11-12: the Foundry Glass layout sat behind an opt-in in Systems, Layout, marked "preview", so Assaf kept seeing the old top bar after every update. Now the default. Three "Redesign SoftwareFactory's plan…" copies could only be told apart by id; the merge list now shows work and spend, and a copy can gather all the others in one press.
