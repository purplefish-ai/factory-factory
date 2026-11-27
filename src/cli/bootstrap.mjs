#!/usr/bin/env node

// Do not import application code here: unsupported Node must reach setup first.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureNode } from './setup-prerequisites.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
let root = directory;
while (!existsSync(join(root, 'package.json')) && dirname(root) !== root) {
  root = dirname(root);
}

async function main() {
  const requirement = readFileSync(join(root, '.node-minimum'), 'utf8').trim();
  if (!(await ensureNode(process.versions.node, requirement))) {
    process.exitCode = 1;
    return;
  }

  const source = existsSync(join(directory, 'index.ts'));
  const args = process.argv.slice(2);
  // Listen before spawning: a signal that lands after the child starts but
  // before the listener exists would kill this process and orphan the child.
  // Listeners run on the event loop, so none runs before `child` is assigned.
  let child;
  const onInterrupt = () => child?.kill('SIGINT');
  const onTerminate = () => child?.kill('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  child = spawn(
    process.execPath,
    [
      ...(source
        ? ['--import', 'tsx', join(directory, 'index.ts')]
        : [join(directory, 'index.js')]),
      ...args,
    ],
    { stdio: 'inherit' }
  );
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
