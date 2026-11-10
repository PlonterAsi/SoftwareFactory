import { formatName } from './naming.js';

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1);
}

export function planRenames(entries, existingNames = []) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const taken = new Set(existingNames);
  for (const e of sorted) taken.add(e.name);

  const renames = [];
  const skipped = [];

  for (const { name, date } of sorted) {
    if (!date) {
      skipped.push({ name, reason: 'no-date' });
      continue;
    }
    const target = formatName(date, extOf(name));
    const dot = target.lastIndexOf('.');
    const base = target.slice(0, dot);
    const suffix = target.slice(dot);

    let candidate = target;
    let n = 2;
    let keep = false;
    while (true) {
      if (candidate === name) {
        keep = true;
        break;
      }
      if (!taken.has(candidate)) break;
      candidate = `${base}_${n}${suffix}`;
      n++;
    }
    if (keep) continue;
    taken.add(candidate);
    renames.push({ from: name, to: candidate });
  }

  return { renames, skipped };
}
