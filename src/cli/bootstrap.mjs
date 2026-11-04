#!/usr/bin/env node

// Do not import application code here: unsupported Node must reach setup first.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureNode } from './serve-prerequisites.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
let root = directory;
while (!existsSync(join(root, 'package.json')) && dirname(root) !== root) {
  root = dirname(root);
}

async function main() {
  const minimum = readFileSync(join(root, '.node-version'), 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(minimum)) {
    throw new Error(
      'The installation has an invalid Node.js requirement. Reinstall Factory Factory.'
    );
  }
  if (!(await ensureNode(process.versions.node, minimum))) {
    process.exitCode = 1;
    return;
  }

  const source = existsSync(join(directory, 'index.ts'));
  const args = process.argv.slice(2);
  if (source && args[0] === 'serve' && !args.includes('--help') && !args.includes('-h')) {
    const native = spawnSync(
      process.execPath,
      [join(root, 'scripts', 'ensure-native-modules.mjs'), 'node'],
      {
        stdio: 'inherit',
      }
    );
    if (native.error) {
      throw native.error;
    }
    if (native.status !== 0) {
      process.exitCode = native.status ?? 1;
      return;
    }
  }
  const child = spawn(
    process.execPath,
    [
      ...(source
        ? ['--import', 'tsx', join(directory, 'index.ts')]
        : [join(directory, 'index.js')]),
      ...args,
    ],
    { stdio: 'inherit' }
  );
  const onInterrupt = () => child.kill('SIGINT');
  const onTerminate = () => child.kill('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  const cleanup = () => {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  };
  child.once('error', (error) => {
    cleanup();
    process.stderr.write(`Could not start Factory Factory: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    cleanup();
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
  });
}

main().catch((error) => {
  process.stderr.write(`Could not start Factory Factory: ${error.message}\n`);
  process.exitCode = 1;
});
