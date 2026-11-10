import fsp from 'node:fs/promises';
import path from 'node:path';
import { readExifDate } from './exif.js';
import { planRenames } from './plan.js';

const defaultFs = {
  readdir: (dir) => fsp.readdir(dir),
  readFile: (p) => fsp.readFile(p),
  rename: (from, to) => fsp.rename(from, to),
};

function isJpeg(name) {
  const lower = name.toLowerCase();
  return lower.endsWith('.jpg') || lower.endsWith('.jpeg');
}

export async function runRename(dir, opts = {}, fsImpl = defaultFs) {
  const listing = await fsImpl.readdir(dir);
  const names = listing.map(String);
  const entries = [];
  for (const name of names.filter(isJpeg)) {
    const bytes = await fsImpl.readFile(path.join(dir, name));
    entries.push({ name, date: readExifDate(bytes) });
  }

  const plan = planRenames(entries, names);

  if (opts.apply) {
    for (const { from, to } of plan.renames) {
      await fsImpl.rename(path.join(dir, from), path.join(dir, to));
    }
  }
  return plan;
}
