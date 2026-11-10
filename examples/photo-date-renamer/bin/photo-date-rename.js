#!/usr/bin/env node
import { runRename } from '../src/run.js';

const USAGE = 'usage: photo-date-rename <dir> [--apply]';

async function main(argv) {
  let apply = false;
  const positional = [];
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg.startsWith('--')) {
      console.error(`unknown option: ${arg}\n${USAGE}`);
      return 2;
    } else positional.push(arg);
  }
  if (positional.length !== 1) {
    console.error(USAGE);
    return 2;
  }

  let result;
  try {
    result = await runRename(positional[0], { apply });
  } catch (err) {
    console.error(`error: cannot process "${positional[0]}": ${err.message}`);
    return 1;
  }

  for (const { from, to } of result.renames) console.log(`${from} -> ${to}`);
  for (const { name, reason } of result.skipped) console.log(`skipped: ${name} (${reason})`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
