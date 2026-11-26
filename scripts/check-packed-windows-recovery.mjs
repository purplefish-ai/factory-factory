// Run only against the private Windows installation created by check-packed-consumer.sh.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';

assert.equal(process.platform, 'win32');
const consumer = join(process.env.RUNNER_TEMP, 'factory-factory-consumer');
const cache = realpathSync(join(consumer, 'npm-cache'));
const npxRoot = join(cache, '_npx');
const installed = realpathSync(readFileSync(join(consumer, 'installed-package.txt'), 'utf8'));
const entry = dirname(dirname(installed));
const key = basename(entry);
assert.match(key, /^[a-f0-9]{16}$/);
assert.equal(installed, join(npxRoot, key, 'node_modules', 'factory-factory'));

// Windows locks a loaded DLL until the process exits. Discover it in a separate Node process.
const binding = realpathSync(
  execFileSync(
    process.execPath,
    [
      '-e',
      `
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  console.log(Object.keys(require.cache).find(file => file.endsWith('.node')));
`,
    ],
    { cwd: installed, encoding: 'utf8', timeout: 10_000 }
  ).trim()
);
assert.ok(binding.startsWith(entry + sep));
const replacement = join(mkdtempSync(join(dirname(binding), 'damaged-')), basename(binding));
writeFileSync(replacement, 'damaged test binding');
renameSync(replacement, binding);

const unrelated = join(mkdtempSync(join(npxRoot, 'unrelated-')), 'package.json');
writeFileSync(unrelated, '{"dependencies":{}}');
const database = join(consumer, 'data', 'test.db');
const snapshot = readFileSync(database);
const env = {
  ...process.env,
  npm_config_cache: cache,
  BASE_DIR: dirname(database),
  DATABASE_PATH: database,
};
const failure = spawnSync(
  process.execPath,
  [join(installed, 'dist/src/cli/bootstrap.mjs'), 'serve', '--no-open'],
  { cwd: consumer, env, encoding: 'utf8', timeout: 30_000 }
);
assert.equal(failure.status, 1, failure.stderr);
assert.match(failure.stderr, /could not load better-sqlite3@/);
const repair = `npm cache npx rm ${key} --cache '${cache.replaceAll("'", "''")}'`;
assert.ok(failure.stderr.split(/\r?\n/).includes(`  ${repair}`), failure.stderr);
execFileSync(
  'pwsh.exe',
  ['-NoProfile', '-NonInteractive', '-Command', `${repair}; exit $LASTEXITCODE`],
  {
    cwd: consumer,
    env,
    stdio: 'inherit',
    timeout: 60_000,
  }
);
assert.ok(!existsSync(entry));
assert.deepEqual(readFileSync(database), snapshot);
assert.equal(readFileSync(unrelated, 'utf8'), '{"dependencies":{}}');
console.log('PowerShell repair removed only the damaged npx entry and preserved the database.');
