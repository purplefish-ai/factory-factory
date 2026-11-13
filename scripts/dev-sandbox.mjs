#!/usr/bin/env node
// Starts the real application (`serve --dev`) in complete isolation so an agent
// can drive it without touching the developer's data, credentials or any
// external service. The pieces live in scripts/sandbox/; see USAGE there.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, USAGE } from './sandbox/args.mjs';
import { cleanSandboxes } from './sandbox/clean.mjs';
import { run } from './sandbox/launch.mjs';

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  if (options.mode === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (process.platform === 'win32') {
    process.stderr.write('dev-sandbox supports macOS and Linux only.\n');
    return 1;
  }
  try {
    if (options.mode === 'clean') {
      await cleanSandboxes({ log: (message) => process.stderr.write(`dev-sandbox: ${message}\n`) });
      return 0;
    }
    return await run(options);
  } catch (error) {
    process.stderr.write(
      `dev-sandbox: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
