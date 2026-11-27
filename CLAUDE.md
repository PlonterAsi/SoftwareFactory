# SoftwareFactory: rules for sessions working here

1. The build follows one list, `build/pieces.json`. Run `node scripts/build-loop/next.mjs` first, and work only the piece marked `now`, through the loop in `docs/build-loop.md`.
2. The only measure is tickets finished well on Assaf's real products. Work on SoftwareFactory itself, test apps and judge counts never count as proof.
3. The new safe path lives in `packages/core/src/fence/` (docs/fence.md). The older engine and Bridge are on hold: read them, reuse what fits a piece, do not extend them.
4. Every number, switch and list is a setting with a safe default. Everything SoftwareFactory holds has create, see, edit, delete. The record is never rewritten.
5. Every source file belongs to a feature record: run `node scripts/wiring.mjs` before the feature map test.
6. Never commit keys or tokens. Never force-push.
