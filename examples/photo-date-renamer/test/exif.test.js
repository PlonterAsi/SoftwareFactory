import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readExifDate } from '../src/exif.js';

function writeEntry(buf, p, tag, type, count, value) {
  buf.writeUInt16LE(tag, p);
  buf.writeUInt16LE(type, p + 2);
  buf.writeUInt32LE(count, p + 4);
  buf.writeUInt32LE(value, p + 8);
}

// Little-endian TIFF block: IFD0 (DateTime 0x0132, ExifIFD pointer 0x8769),
// ExifIFD (DateTimeOriginal 0x9003), ASCII strings stored after the IFDs.
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

const EXPECTED = new Date(2024, 4, 17, 14, 3, 22);

describe('readExifDate', () => {
  test('readExifDate returns the DateTimeOriginal from a hand-built JPEG APP1 Exif Buffer, falls back to IFD0 DateTime when DateTimeOriginal is absent, and returns null for non-JPEG, missing or truncated input without throwing.', () => {
    const other = new Date(2019, 0, 1, 8, 0, 0);

    const both = jpegWithExif({ dt: '2019:01:01 08:00:00', dto: '2024:05:17 14:03:22' });
    const got = readExifDate(both);
    assert.ok(got instanceof Date);
    assert.equal(got.getTime(), EXPECTED.getTime());
    assert.notEqual(got.getTime(), other.getTime());
  });

  test('readExifDate returns the DateTimeOriginal from a hand-built JPEG APP1 Exif Buffer', () => {
    const buf = jpegWithExif({ dto: '2024:05:17 14:03:22' });
    const got = readExifDate(buf);
    assert.ok(got instanceof Date);
    assert.equal(got.getTime(), EXPECTED.getTime());
  });

  test('readExifDate prefers DateTimeOriginal over IFD0 DateTime when both are present', () => {
    const buf = jpegWithExif({ dt: '2019:01:01 08:00:00', dto: '2024:05:17 14:03:22' });
    assert.equal(readExifDate(buf).getTime(), EXPECTED.getTime());
  });

  test('readExifDate falls back to IFD0 DateTime when DateTimeOriginal is absent', () => {
    const buf = jpegWithExif({ dt: '2024:05:17 14:03:22' });
    const got = readExifDate(buf);
    assert.ok(got instanceof Date);
    assert.equal(got.getTime(), EXPECTED.getTime());
  });

  test('readExifDate returns null for non-JPEG input', () => {
    assert.equal(readExifDate(Buffer.from('this is plain text, not a photo')), null);
    assert.equal(readExifDate(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), null);
    assert.equal(readExifDate(Buffer.alloc(0)), null);
  });

  test('readExifDate returns null for JPEG input with missing EXIF', () => {
    // SOI + APP0 (JFIF) + EOI, no APP1 Exif block
    const jfif = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]);
    assert.equal(readExifDate(jfif), null);
  });

  test('readExifDate returns null for truncated input', () => {
    const full = jpegWithExif({ dt: '2019:01:01 08:00:00', dto: '2024:05:17 14:03:22' });
    assert.equal(readExifDate(full.subarray(0, 30)), null);
    assert.equal(readExifDate(full.subarray(0, 12)), null);
    assert.equal(readExifDate(full.subarray(0, 4)), null);
  });

  test('readExifDate never throws', () => {
    assert.doesNotThrow(() => readExifDate(undefined));
    assert.doesNotThrow(() => readExifDate(null));
    assert.doesNotThrow(() => readExifDate(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00])));
    assert.equal(readExifDate(undefined), null);
    assert.equal(readExifDate(null), null);
  });
});
