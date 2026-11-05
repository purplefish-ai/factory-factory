// Run against an isolated consumer installation, never the checkout's resolver.
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const directory = process.argv[2];
if (!directory) {
  throw new Error('Expected installed factory-factory package directory');
}
const require = createRequire(resolve(realpathSync(directory), 'package.json'));
const Database = require('better-sqlite3');
const db = new Database(':memory:');
try {
  if (db.prepare('SELECT 1 AS value').get().value !== 1) {
    throw new Error('Installed SQLite native module failed');
  }
} finally {
  db.close();
}

const pty = require('node-pty');
const terminal = pty.spawn('/bin/sh', ['-c', 'printf native-pty-ready'], {
  cols: 80,
  rows: 24,
  cwd: directory,
});
let output = '';
const timeout = setTimeout(() => {
  terminal.kill();
  process.exitCode = 1;
}, 10_000);
terminal.onData((data) => {
  output += data;
});
terminal.onExit(({ exitCode }) => {
  clearTimeout(timeout);
  if (exitCode !== 0 || !output.includes('native-pty-ready')) {
    console.error('Installed PTY failed to spawn and return output');
    process.exitCode = 1;
  }
});
