const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TYPE_ASCII = 2;

function parseDate(str) {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(str);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const date = new Date(y, mo - 1, d, h, mi, s);
  if (
    date.getFullYear() !== y ||
    date.getMonth() !== mo - 1 ||
    date.getDate() !== d ||
    date.getHours() !== h ||
    date.getMinutes() !== mi ||
    date.getSeconds() !== s
  ) {
    return null;
  }
  return date;
}

// Reads one IFD into a Map of tag -> entry position. Throws on out-of-range reads.
function readIfd(tiff, le, offset) {
  const u16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const count = u16(offset);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const p = offset + 2 + i * 12;
    if (p + 12 > tiff.length) throw new RangeError('truncated IFD');
    entries.set(u16(p), p);
  }
  return entries;
}

function readAscii(tiff, le, entryPos) {
  const u16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  if (u16(entryPos + 2) !== TYPE_ASCII) return null;
  const count = u32(entryPos + 4);
  const start = count <= 4 ? entryPos + 8 : u32(entryPos + 8);
  if (count === 0 || start + count > tiff.length) return null;
  return tiff.toString('latin1', start, start + count).replace(/\0.*$/s, '');
}

function dateFromTiff(tiff) {
  if (tiff.length < 8) return null;
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const u16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  if (u16(2) !== 42) return null;

  const ifd0 = readIfd(tiff, le, u32(4));

  let result = null;
  const exifPtr = ifd0.get(TAG_EXIF_IFD);
  if (exifPtr !== undefined) {
    try {
      const exifIfd = readIfd(tiff, le, u32(exifPtr + 8));
      const pos = exifIfd.get(TAG_DATETIME_ORIGINAL);
      if (pos !== undefined) {
        const s = readAscii(tiff, le, pos);
        if (s) result = parseDate(s);
      }
    } catch {
      result = null;
    }
  }
  if (result) return result;

  const dtPos = ifd0.get(TAG_DATETIME);
  if (dtPos !== undefined) {
    const s = readAscii(tiff, le, dtPos);
    if (s) return parseDate(s);
  }
  return null;
}

export function readExifDate(buf) {
  try {
    if (!buf || !(buf instanceof Uint8Array)) return null;
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;

    let pos = 2;
    while (pos + 4 <= b.length) {
      if (b[pos] !== 0xff) return null;
      const marker = b[pos + 1];
      if (marker === 0xff) {
        pos += 1;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return null;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        pos += 2;
        continue;
      }
      const len = b.readUInt16BE(pos + 2);
      if (len < 2) return null;
      const end = pos + 2 + len;
      if (end > b.length) return null;
      if (marker === 0xe1) {
        const bodyStart = pos + 4;
        if (end - bodyStart >= 6 && b.toString('latin1', bodyStart, bodyStart + 6) === 'Exif\0\0') {
          return dateFromTiff(b.subarray(bodyStart + 6, end));
        }
      }
      pos = end;
    }
    return null;
  } catch {
    return null;
  }
}
