# The build loop

SoftwareFactory is built from one list, `build/pieces.json`, made from the definition (seven legs, the whole
definition, the step 1 plan). Exactly one piece is `now`. Any session, on any machine, picks up from the file:
`node scripts/build-loop/next.mjs` says which piece is now and what proves it.

## One turn of the loop

1. **Pick.** The piece marked `now`. Nothing else is started.
2. **Say it.** A few lines in `docs/` for that piece: what it does, what it leaves alone, how it is checked. The
   definition page of its leg is the source; the piece never widens it.
3. **Build.** Tests first where a rule can be tested. Every number, switch and list is a setting with a safe
   default; everything SoftwareFactory holds can be created, seen, edited and deleted (the record is the exception).
4. **Check.** `npm run typecheck`, the tests of what changed, `node packages/core/scripts/wiring.mjs` and the feature map test.
5. **Second pair of eyes.** A reviewer that did not write the piece reads the diff. Nobody judges their own work.
6. **Fix** what the reviewer found, and check again. At most three rounds; what is still open is written down.
7. **Wire.** The piece is reachable from the installed app before the next piece starts. No half-built surface.
8. **Prove.** On the laptop, on a real product (RoadToMill first), the piece's `done` line happens for real.
   Work on SoftwareFactory itself never counts as proof.
9. **Mark.** `built` when steps 1 to 7 are through, `proven` when step 8 is. The next piece becomes `now`.
   The picture of the list is redrawn.

## Ends of a turn

A turn ends as one of: built, proven, parked (with the reason and the one thing that clears it). A parked piece
does not stop the loop: the next piece that does not depend on it becomes `now`.

## What the loop never does

It never changes the protected core by itself (stop list, fence, limits, record, watchdog, score, judge), never
spends money, never presses his buttons, and never counts its own work on SoftwareFactory as progress.
