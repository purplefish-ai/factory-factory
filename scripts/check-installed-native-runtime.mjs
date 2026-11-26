// Exercise the native modules using only the installed package's dependency tree.
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { probeSqliteDrivers, resolveSqliteDrivers } from '../src/cli/sqlite-runtime.mjs';

const directory = process.argv[2];
if (!directory) {
  throw new Error('Expected installed factory-factory package directory');
}
const packageRoot = realpathSync(directory);
const require = createRequire(resolve(packageRoot, 'package.json'));
// Exercise the built adapter even when verifying dist in a source checkout.
const drivers = resolveSqliteDrivers(packageRoot, false);
console.log(
  JSON.stringify(
    {
      node: process.version,
      abi: process.versions.modules,
      platform: process.platform,
      arch: process.arch,
      drivers,
    },
    null,
    2
  )
);
probeSqliteDrivers(drivers);
if (new Set(drivers.map((driver) => driver.path)).size !== 1) {
  throw new Error('Factory Factory and the Prisma adapter resolved distinct SQLite drivers');
}

const { PrismaClient } = require('./dist/prisma/generated/client.js');
const { TunedPrismaBetterSqlite3 } = require('./dist/src/backend/lib/sqlite-adapter.js');
const prisma = new PrismaClient({ adapter: new TunedPrismaBetterSqlite3({ url: ':memory:' }) });
try {
  const [row] = await prisma.$queryRaw`SELECT 1 AS value`;
  if (Number(row?.value) !== 1) {
    throw new Error('Installed Prisma adapter failed its SQLite query');
  }
} finally {
  await prisma.$disconnect();
}

const windows = process.platform === 'win32';
const shell = windows ? 'cmd.exe' : '/bin/sh';
const args = windows ? ['/d', '/c', 'echo native-pty-ready'] : ['-c', 'printf native-pty-ready'];
const pty = require('node-pty');
const terminal = pty.spawn(shell, args, {
  cols: 80,
  rows: 24,
  cwd: directory,
});
let output = '';
const timeout = setTimeout(() => {
  console.error('Installed PTY timed out before returning shell output and exit status');
  try {
    terminal.kill();
  } finally {
    process.exit(1);
  }
}, 10_000);
terminal.onData((data) => {
  output += data;
});
terminal.onExit(({ exitCode }) => {
  clearTimeout(timeout);
  if (exitCode !== 0 || !output.includes('native-pty-ready')) {
    console.error('Installed PTY failed to spawn and return output');
    process.exit(1);
  }
  console.log('Installed PTY returned the expected output and exit status.');
  // node-pty's Windows ConPTY worker can outlive a normally exited shell.
  // This dedicated smoke process has now observed both pieces of evidence.
  if (windows) {
    process.exit(0);
  }
});
