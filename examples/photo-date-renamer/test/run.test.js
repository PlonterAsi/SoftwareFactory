import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runRename } from '../src/run.js';

const BIN = fileURLToPath(new URL('../bin/photo-date-rename.js', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

function writeEntry(buf, p, tag, type, count, value) {
  buf.writeUInt16LE(tag, p);
  buf.writeUInt16LE(type, p + 2);
  buf.writeUInt32LE(count, p + 4);
  buf.writeUInt32LE(value, p + 8);
}

function tiffBlock({ dt, dto }) {
  const dtBytes = dt === undefined ? null : Buffer.from(dt + '\0', 'latin1');
  const dtoBytes = dto === undefined ? null : Buffer.from(dto + '\0', 'latin1');
  const n0 = 1 + (dtBytes ? 1 : 0);
  const ifd0Off = 8;
  const exifOff = ifd0Off + 2 + 12 * n0 + 4;
  const nExif = dtoBytes ? 1 : 0;
  let off = exifOff + 2 + 12 * nExif + 4;
  const dtOff = off;
  if (dtBytes) off += dtBytes.length;
  const dtoOff = off;
  if (dtoBytes) off += dtoBytes.length;

  const buf = Buffer.alloc(off);
  buf.write('II', 0, 'latin1');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(ifd0Off, 4);

  let p = ifd0Off;
  buf.writeUInt16LE(n0, p);
  p += 2;
  if (dtBytes) {
    writeEntry(buf, p, 0x0132, 2, dtBytes.length, dtOff);
    p += 12;
  }
  writeEntry(buf, p, 0x8769, 4, 1, exifOff);
  p += 12;
  buf.writeUInt32LE(0, p);

  p = exifOff;
  buf.writeUInt16LE(nExif, p);
  p += 2;
  if (dtoBytes) {
    writeEntry(buf, p, 0x9003, 2, dtoBytes.length, dtoOff);
    p += 12;
  }
  buf.writeUInt32LE(0, p);

  if (dtBytes) dtBytes.copy(buf, dtOff);
  if (dtoBytes) dtoBytes.copy(buf, dtoOff);
  return buf;
}

function jpegWithExif(opts) {
  const app1Body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiffBlock(opts)]);
  const len = app1Body.length + 2;
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe1, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([head, app1Body, Buffer.from([0xff, 0xd9])]);
}

// In-memory fs double; keys are file names in the fake directory.
function fakeFs(files) {
  const calls = { readdir: [], readFile: [], rename: [] };
  return {
    calls,
    readdir: async (dir) => {
      calls.readdir.push(dir);
      return Object.keys(files);
    },
    readFile: async (p) => {
      const name = path.basename(p);
      calls.readFile.push(name);
      return files[name];
    },
    rename: async (from, to) => {
      calls.rename.push([path.basename(from), path.basename(to)]);
    },
  };
}

const JPG_A = jpegWithExif({ dto: '2024:05:17 14:03:22' });
const JPG_B = jpegWithExif({ dto: '2023:01:02 09:00:00' });

describe('runRename', () => {
  test('runRename with apply false calls rename zero times', async () => {
    const fsImpl = fakeFs({ 'a.jpg': JPG_A, 'b.JPEG': JPG_B });
    const result = await runRename('/fake/dir', { apply: false }, fsImpl);
    assert.equal(fsImpl.calls.rename.length, 0);
    assert.deepStrictEqual(result.renames, [
      { from: 'a.jpg', to: '2024-05-17_14-03-22.jpg' },
      { from: 'b.JPEG', to: '2023-01-02_09-00-00.jpeg' },
    ]);
    assert.deepStrictEqual(result.skipped, []);
  });

  test('runRename with apply true calls rename exactly once per planned pair, using an injected fsImpl in tests.', async () => {
    const fsImpl = fakeFs({ 'a.jpg': JPG_A, 'b.JPEG': JPG_B });
    const result = await runRename('/fake/dir', { apply: true }, fsImpl);
    assert.equal(fsImpl.calls.rename.length, result.renames.length);
    assert.equal(fsImpl.calls.rename.length, 2);
    assert.deepStrictEqual(fsImpl.calls.rename, [
      ['a.jpg', '2024-05-17_14-03-22.jpg'],
      ['b.JPEG', '2023-01-02_09-00-00.jpeg'],
    ]);
  });

  test('runRename keeps only .jpg and .jpeg files and reads only those', async () => {
    const fsImpl = fakeFs({ 'a.jpg': JPG_A, 'notes.txt': Buffer.from('x'), 'b.JPEG': JPG_B });
    const result = await runRename('/fake/dir', { apply: false }, fsImpl);
    assert.ok(!fsImpl.calls.readFile.includes('notes.txt'));
    assert.ok(fsImpl.calls.readFile.includes('a.jpg'));
    assert.ok(fsImpl.calls.readFile.includes('b.JPEG'));
    assert.equal(result.renames.length, 2);
  });

  test('runRename reports files without an EXIF date as skipped with reason no-date', async () => {
    const fsImpl = fakeFs({ 'nodate.jpg': Buffer.from('garbage bytes') });
    const result = await runRename('/fake/dir', { apply: false }, fsImpl);
    assert.deepStrictEqual(result.renames, []);
    assert.deepStrictEqual(result.skipped, [{ name: 'nodate.jpg', reason: 'no-date' }]);
    assert.equal(fsImpl.calls.rename.length, 0);
  });

  test('runRename passes the directory listing as existingNames so clashes get _2', async () => {
    // The listing already holds the target name for b.jpg (as a separate file)
    const fsImpl = fakeFs({
      '2024-05-17_14-03-22.jpg': JPG_A,
      'b.jpg': JPG_A,
    });
    const result = await runRename('/fake/dir', { apply: false }, fsImpl);
    assert.deepStrictEqual(result.renames, [
      { from: 'b.jpg', to: '2024-05-17_14-03-22_2.jpg' },
    ]);
    assert.equal(fsImpl.calls.rename.length, 0);
  });
});

describe('package.json', () => {
  test('package.json has no dependencies or devDependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0);
    assert.ok(!pkg.devDependencies || Object.keys(pkg.devDependencies).length === 0);
  });
});

describe('CLI bin/photo-date-rename.js', () => {
  const made = [];

  function makeDir(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdr-cli-'));
    made.push(dir);
    for (const [name, buf] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), buf);
    }
    return dir;
  }

  function cli(args) {
    return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
  }

  after(() => {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('The CLI prints the dry-run plan as from -> to lines and exits 0', () => {
    const dir = makeDir({
      'a.jpg': JPG_A,
      'nodate.jpg': Buffer.from('garbage'),
    });
    const r = cli([dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('a.jpg -> 2024-05-17_14-03-22.jpg'), r.stdout);
    assert.ok(r.stdout.includes('skipped: nodate.jpg (no-date)'), r.stdout);
    // dry run must not touch files
    assert.ok(fs.existsSync(path.join(dir, 'a.jpg')));
    assert.ok(!fs.existsSync(path.join(dir, '2024-05-17_14-03-22.jpg')));
  });

  test('with --apply the CLI performs the renames and exits 0', () => {
    const dir = makeDir({ 'a.jpg': JPG_A });
    const r = cli([dir, '--apply']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(dir, '2024-05-17_14-03-22.jpg')));
    assert.ok(!fs.existsSync(path.join(dir, 'a.jpg')));
  });

  test('the CLI exits 1 when <dir> is missing', () => {
    const missing = path.join(os.tmpdir(), 'pdr-does-not-exist-' + process.pid + '-' + Date.now());
    const r = cli([missing]);
    assert.equal(r.status, 1, r.stderr);
  });

  test('the CLI exits 2 on bad usage', () => {
    const r = cli([]);
    assert.equal(r.status, 2, r.stderr);
  });
});
