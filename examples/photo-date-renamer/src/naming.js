const pad = (n) => String(n).padStart(2, '0');

export function formatName(date, ext) {
  const e = String(ext).replace(/^\./, '').toLowerCase();
  const y = String(date.getFullYear()).padStart(4, '0');
  return (
    `${y}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}.${e}`
  );
}
