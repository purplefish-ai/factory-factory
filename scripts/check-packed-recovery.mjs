// Called after a healthy Linux/macOS packed launch, before repeating the same smoke test.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { basename, dirname, join, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [cacheArg, packageArg, tarball, cwd, databaseArg] = process.argv.slice(2);
const cache = realpathSync(cacheArg);
const packageRoot = realpathSync(packageArg);
const databasePath = realpathSync(databaseArg);
const key = createHash('sha512').update(tarball).digest('hex').slice(0, 16);
const npxRoot = join(cache, '_npx');
const entry = join(npxRoot, key);
assert.equal(packageRoot, join(entry, 'node_modules', 'factory-factory'));
assert.ok(!databasePath.startsWith(cache + sep));

// Keep a second key in the same cache so an over-broad cache removal fails the test.
const unrelated = mkdtempSync(join(npxRoot, 'recovery-unrelated-'));
writeFileSync(join(unrelated, 'package.json'), '{"dependencies":{}}');
const sentinel = readFileSync(join(unrelated, 'package.json'));
const app = createRequire(join(packageRoot, 'package.json'));
const adapter = createRequire(app.resolve('./dist/src/backend/lib/sqlite-adapter.js'));
const Database = adapter('better-sqlite3');
const database = new Database(databasePath, { fileMustExist: true });
try {
  database.exec(
    "CREATE TABLE IF NOT EXISTS recovery_sentinel (value TEXT); INSERT INTO recovery_sentinel VALUES ('keep');"
  );
} finally {
  database.close();
}
const snapshot = readFileSync(databasePath);
const binding = Object.keys(adapter.cache).find((path) => path.endsWith('.node'));
assert.ok(
  binding && realpathSync(binding).startsWith(entry + sep),
  'Expected a private installed SQLite binding'
);
const binary = realpathSync(binding);

const env = {
  ...process.env,
  HOME: join(cwd, 'home'),
  npm_config_yes: 'true',
  CI: 'true',
  npm_config_cache: cache,
  BASE_DIR: dirname(databasePath),
  DATABASE_PATH: databasePath,
};
const bootstrap = join(packageRoot, 'dist/src/cli/bootstrap.mjs');
const listener = createServer().listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = String(listener.address().port);
await new Promise((done) => listener.close(done));
const launchArgs = [
  'serve',
  '--no-open',
  '--host',
  '127.0.0.1',
  '--port',
  port,
  '--database-path',
  databasePath,
];

// A migration that fails after the probe must still report the migration error.
const invalid = join(mkdtempSync(join(cwd, 'migration-failure-')), 'invalid.db');
writeFileSync(invalid, 'invalid sqlite database');
const migration = spawnSync(process.execPath, [bootstrap, ...launchArgs.slice(0, -1), invalid], {
  cwd,
  env,
  encoding: 'utf8',
  timeout: 30_000,
});
assert.equal(migration.status, 1, migration.stderr);
assert.match(migration.stderr, /Migration failed:.*not a database/i);
assert.doesNotMatch(migration.stderr, /cache npx rm/);

// Replace the directory entry rather than writing into a potentially shared inode.
const broken = join(mkdtempSync(join(dirname(binary), 'damaged-')), basename(binary));
writeFileSync(broken, 'damaged test binding');
renameSync(broken, binary);

const failure = spawnSync(process.execPath, [bootstrap, ...launchArgs], {
  cwd,
  env,
  encoding: 'utf8',
  timeout: 30_000,
});
assert.equal(failure.status, 1, failure.stderr);
console.log(failure.stderr);
assert.match(failure.stderr, /could not load better-sqlite3@/);

// Compare with the independently derived, bounded argv before executing the printed command.
function quoted(arg) {
  return /^[a-zA-Z0-9_./:@=-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}
const repair = ['cache', 'npx', 'rm', key, '--cache', cache];
const relaunch = [
  'exec',
  '--cache',
  cache,
  '--package',
  tarball,
  '--',
  'factory-factory',
  ...launchArgs,
];
for (const command of [repair, relaunch]) {
  assert.ok(
    failure.stderr.split('\n').includes(`  npm ${command.map(quoted).join(' ')}`),
    'Missing scoped recovery command'
  );
}
execFileSync('npm', repair, { cwd, env, stdio: 'inherit', timeout: 30_000 });
assert.ok(!existsSync(entry));
assert.deepEqual(readFileSync(databasePath), snapshot);
assert.deepEqual(readFileSync(join(unrelated, 'package.json')), sentinel);
console.log('Scoped repair preserved the preexisting database and unrelated cache entry.');

const repaired = spawn('npm', relaunch, {
  cwd,
  env,
  detached: true,
  stdio: ['ignore', 'inherit', 'inherit'],
});
const exited = once(repaired, 'exit');
const origin = `http://127.0.0.1:${port}`;
async function verifyRelaunch() {
  // A cold dependency reinstall can take longer than the server's own startup.
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && repaired.exitCode === null && repaired.signalCode === null) {
    const health = await fetch(`${origin}/health/database`, {
      signal: AbortSignal.timeout(1500),
    }).catch(() => undefined);
    if (health?.status === 200) {
      app('zod')
        .object({ database: app('zod').literal('connected') })
        .parse(await health.json());
      const ui = await fetch(origin, { signal: AbortSignal.timeout(5000) });
      assert.equal(ui.status, 200);
      assert.match(await ui.text(), /id="root"/);
      const db = new Database(databasePath, { readonly: true, fileMustExist: true });
      try {
        assert.ok(db.prepare("SELECT value FROM recovery_sentinel WHERE value = 'keep'").get());
      } finally {
        db.close();
      }
      assert.deepEqual(readFileSync(join(unrelated, 'package.json')), sentinel);
      return;
    }
    await delay(500);
  }
  throw new Error('Timed out waiting for the printed relaunch command');
}
function signalGroup(signal) {
  if (!repaired.pid) {
    return;
  }
  try {
    process.kill(-repaired.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  }
}
try {
  await Promise.race([
    verifyRelaunch(),
    exited.then(([code, signal]) => {
      throw new Error(`Repaired serve exited: ${code ?? signal}`);
    }),
  ]);
  console.log(
    'The printed relaunch command served the UI and connected database with both sentinels intact.'
  );
} finally {
  signalGroup('SIGTERM');
  await Promise.race([exited, delay(5000, null, { ref: false })]).finally(() =>
    signalGroup('SIGKILL')
  );
}
