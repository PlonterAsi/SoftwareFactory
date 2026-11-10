# Photo Date Renamer

Dependency-free Node.js 22 CLI that renames JPEGs to their EXIF capture time (`YYYY-MM-DD_HH-mm-ss.jpg`).

    node bin/photo-date-rename.js <dir>           # dry run (default)
    node bin/photo-date-rename.js <dir> --apply   # perform renames

Uses DateTimeOriginal, falling back to IFD0 DateTime. Clashes get `_2`, `_3`, ... Exit codes: 0 ok, 1 bad/missing dir, 2 bad usage. Run tests with `npm test`.
