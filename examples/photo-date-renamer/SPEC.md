# Photo Date Renamer

> a CLI that renames photos by the date they were taken

A dependency-free Node.js CLI that renames JPEG photos in a folder to their EXIF capture date and time, with a dry run by default.

## Interface

src/exif.js: export function readExifDate(buf: Buffer): Date | null. Parses a JPEG APP1 'Exif' block: IFD0 -> ExifIFD pointer (0x8769) -> DateTimeOriginal (0x9003), falling back to IFD0 DateTime (0x0132). The value 'YYYY:MM:DD HH:MM:SS' becomes a local-time Date. Returns null for non-JPEG input, missing EXIF, or truncated data. Never throws.
src/naming.js: export function formatName(date: Date, ext: string): string. Returns 'YYYY-MM-DD_HH-mm-ss.' + ext.toLowerCase(), using local-time fields. The ext argument may be given with or without a leading dot.
src/plan.js: export function planRenames(entries: {name: string, date: Date|null}[], existingNames?: string[]): {renames: {from: string, to: string}[], skipped: {name: string, reason: string}[]}. Sorts entries by name. A null date gives skipped with reason 'no-date'. Otherwise the target is formatName(date, ext). On a clash with a planned target or an existing name, appends _2, _3, ... before the extension. An entry whose target equals its own name is omitted.
src/run.js: export async function runRename(dir: string, opts: {apply: boolean}, fsImpl?: {readdir, readFile, rename}): Promise<{renames, skipped}>. Lists dir, keeps .jpg and .jpeg files, reads each file's bytes, calls readExifDate, then planRenames, passing the directory listing as existingNames. Calls fsImpl.rename(from, to) only when apply is true. The injectable fs makes it testable without real files.
bin/photo-date-rename.js CLI: photo-date-rename <dir> [--apply]. The default is a dry run that prints 'from -> to' per planned rename and 'skipped: <name> (<reason>)' per skipped file. --apply performs the renames. Exit codes: 0 on success, 1 if <dir> is missing or unreadable, 2 on bad usage.

## Acceptance criteria

1. readExifDate returns the DateTimeOriginal from a hand-built JPEG APP1 Exif Buffer, falls back to IFD0 DateTime when DateTimeOriginal is absent, and returns null for non-JPEG, missing or truncated input without throwing.
2. formatName(new Date(2024, 4, 17, 14, 3, 22), 'JPG') returns '2024-05-17_14-03-22.jpg', and the ext argument works with or without a leading dot.
3. planRenames appends _2, _3 to targets that clash with other planned targets or with existingNames, and never plans a rename that would overwrite an existing name.
4. Entries with a null date appear in skipped with reason 'no-date', and entries whose target already equals their name produce no rename.
5. planRenames is deterministic: the same input gives the same output, and renames are ordered by source name.
6. runRename with apply false calls rename zero times; with apply true it calls rename exactly once per planned pair, using an injected fsImpl in tests.
7. The CLI prints the dry-run plan as 'from -> to' lines and exits 0; with --apply it performs the renames; it exits 1 when <dir> is missing and 2 on bad usage.
8. All tests run with 'node --test' on Node 22, and package.json has no dependencies or devDependencies.

## Tasks

- **t1** Scaffold package.json (type module, test script) and folder layout
- **t2** Implement src/exif.js readExifDate with JPEG/TIFF byte parsing and tests (after t1)
- **t3** Implement src/naming.js formatName with tests (after t1)
- **t4** Implement src/plan.js planRenames with collision and skip logic and tests (after t3)
- **t5** Implement src/run.js runRename with injectable fs and tests (after t2, t4)
- **t6** Implement bin/photo-date-rename.js CLI wrapper, exit codes, and CLI smoke test (after t5)

Built by SoftwareFactory. The tests in `test/` were written from this spec before the code and were locked.
