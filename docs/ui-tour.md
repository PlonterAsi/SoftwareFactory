# UI tour

The safety net for redesign work on the Bridge. `npm run ui:tour` starts a throwaway core (practice crew, a new temp database, removed afterwards) and the Bridge dev server, makes one shipped build and one build waiting at the plan approval, then opens every page, every project panel (including panels other threads register) and the Systems drawer.

For each screen it takes a 1440 x 900 screenshot and checks that it rendered: no console errors, no uncaught exceptions, and visible text on the page. It exits with an error and lists the problems when one fails.

```
npm run ui:tour -- --out before     # before your change
npm run ui:tour -- --out after      # after it
```

Each run writes `ui-tour-out/<name>/` with the screenshots, `contact-sheet.html` (all screens on one page) and `problems.txt`. Compare the two contact sheets before merging a visual change. Needs Git and Playwright with Chromium (preinstalled in cloud threads). The `ui-tour-out/` folder is ignored by git.

The redesign it guards: "Foundry Glass" (https://claude.ai/artifact/BUevHm6B2yRRUC7f837Dze).
