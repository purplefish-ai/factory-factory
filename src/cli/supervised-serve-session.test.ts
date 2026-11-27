import { ChildProcess, execFile, type Serializable } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateSupervisorMessageSchema } from '@/shared/application-updates';
import { createTestEventLog } from '@/test-utils/test-event-log';
import type { PreparedApplicationUpdate } from './application-update-installer';
import { runServeSession } from './serve-session';
import { runSupervisedServeSession } from './supervised-serve-session';

const mocks = vi.hoisted(() => ({
  supported: true,
  otherServers: false,
  constructed: vi.fn(),
  prepare: vi.fn<(version: string, signal: AbortSignal) => Promise<PreparedApplicationUpdate>>(),
  persist: vi.fn<(...args: unknown[]) => Promise<void>>(),
  migrate: vi.fn<() => Promise<void>>(),
  /** What the `db:migrate` child writes to standard error, whether it succeeds or fails. */
  migrateStderr: '',
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));
vi.mock('./serve-session', () => ({ runServeSession: vi.fn() }));
vi.mock('./application-update-installer', async (original) => ({
  ...(await original<typeof import('./application-update-installer')>()),
  ApplicationUpdateInstaller: class {
    constructor(options: unknown) {
      mocks.constructed(options);
    }
    isSupported() {
      return Promise.resolve(mocks.supported);
    }
    prepare(version: string, signal: AbortSignal) {
      return mocks.prepare(version, signal);
    }
  },
  hasOtherApplicationServers: () => Promise.resolve(mocks.otherServers),
}));
vi.mock('./application-update-recovery', async (original) => ({
  ...(await original<typeof import('./application-update-recovery')>()),
  persistApplicationUpdateState: mocks.persist,
}));

type ServeOptions = Parameters<typeof runServeSession>[0];
interface RunningBackend {
  child: ChildProcess;
  options: ServeOptions;
  messages: Serializable[];
  listening: Promise<void>;
}
let directory: string;
let databasePath: string;
let packageRoot: string;
let versionFile: string;
let controller: AbortController;
let session: Promise<void> | undefined;
let backends: ReturnType<typeof createTestEventLog<RunningBackend>>;
let preparationStarted: Promise<void>;
let prepared: PreparedApplicationUpdate;
const onReady = vi.fn<() => Promise<void>>();

function exit(child: ChildProcess, code = 0) {
  Object.defineProperty(child, 'exitCode', { configurable: true, value: code });
  child.emit('exit', code, null);
}

function databaseValue() {
  const database = new Database(databasePath);
  try {
    return database.prepare('SELECT value FROM test_data').pluck().get();
  } finally {
    database.close();
  }
}

function start(dev = false) {
  session = runSupervisedServeSession({
    projectRoot: packageRoot,
    databasePath,
    env: { DATABASE_PATH: databasePath, CUSTOM_OPTION: 'preserved' },
    host: '0.0.0.0',
    frontendPort: 4321,
    backendPort: 4322,
    verbose: true,
    dev,
    signal: controller.signal,
    onReady,
  });
}

function valueIn(path: string) {
  const database = new Database(path, { readonly: true });
  try {
    return database.prepare('SELECT value FROM test_data').pluck().get();
  } finally {
    database.close();
  }
}

/** The new package ships 001 and 002; the database has applied 001, so 002 is pending. */
async function makeMigrationPending() {
  const migrations = join(packageRoot, 'prisma', 'migrations');
  for (const name of ['001_init', '002_next']) {
    await mkdir(join(migrations, name), { recursive: true });
    await writeFile(join(migrations, name, 'migration.sql'), 'SELECT 1;');
  }
  const database = new Database(databasePath);
  database.exec(
    'CREATE TABLE _prisma_migrations (id TEXT PRIMARY KEY, checksum TEXT, migration_name TEXT, finished_at TEXT);' +
      "INSERT INTO _prisma_migrations VALUES ('1', '', '001_init', CURRENT_TIMESTAMP);"
  );
  database.close();
}

async function preMigrationBackups() {
  const names = await readdir(join(directory, 'db-backups')).catch(() => []);
  return names.filter((name) => name.startsWith('data.db-pre-migration-')).sort();
}

function failedUpdateError(running: RunningBackend): string {
  running.child.emit('message', { type: 'update-hello' });
  for (const raw of running.messages) {
    const message = updateSupervisorMessageSchema.parse(raw);
    if (message.type === 'update-status' && message.status.phase === 'failed') {
      return message.status.error ?? '';
    }
  }
  return '';
}

async function backend(index = 0) {
  await backends.waitForCount(index + 1);
  return backends.events[index]!;
}

async function ready(running: RunningBackend) {
  running.child.emit('message', { type: 'update-backend-ready' });
  await running.listening;
}

async function requestUpdate(holdExit = false) {
  start();
  const original = await backend();
  await ready(original);
  original.child.emit('message', { type: 'update-request', version: '0.5.4' });
  expect(original.messages).toContainEqual({
    type: 'update-status',
    status: { phase: 'waiting', targetVersion: '0.5.4' },
  });
  // Let any installation started by the request reach the installer.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(mocks.prepare).not.toHaveBeenCalled();
  const stopRequested = Promise.withResolvers<void>();
  if (holdExit) {
    vi.mocked(original.child.kill).mockImplementation(() => {
      stopRequested.resolve();
      return true;
    });
  }
  original.child.emit('message', { type: 'update-ready' });
  await preparationStarted;
  expect(mocks.prepare).toHaveBeenCalledOnce();
  return { ...original, stopRequested: stopRequested.promise };
}

beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), 'ff-supervised-serve-'));
  packageRoot = join(directory, 'factory-factory');
  versionFile = join(directory, 'installed-version');
  databasePath = join(directory, 'data.db');
  await writeFile(versionFile, '0.5.3');
  // The new package's migrations: none pending unless a test adds them.
  await mkdir(join(packageRoot, 'prisma', 'migrations'), { recursive: true });
  const database = new Database(databasePath);
  database.exec(
    "CREATE TABLE test_data(value TEXT); INSERT INTO test_data VALUES ('before update');"
  );
  database.close();
  controller = new AbortController();
  backends = createTestEventLog<RunningBackend>();
  session = undefined;
  mocks.supported = true;
  mocks.otherServers = false;
  mocks.persist.mockResolvedValue();
  mocks.migrate.mockResolvedValue();
  mocks.migrateStderr = '';
  onReady.mockResolvedValue();
  prepared = {
    packageRoot,
    recoveryPath: join(directory, 'previous'),
    activate: vi.fn(async () => {
      await writeFile(versionFile, '0.5.4');
    }),
    rollback: vi.fn(async () => {
      await writeFile(versionFile, '0.5.3');
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  const preparation = Promise.withResolvers<void>();
  preparationStarted = preparation.promise;
  mocks.prepare.mockImplementation(() => {
    preparation.resolve();
    return Promise.resolve(prepared);
  });
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      void mocks.migrate().then(
        () => callback(null, '', mocks.migrateStderr),
        (error: unknown) => callback(error, '', mocks.migrateStderr)
      );
    }
    return new ChildProcess();
  });
  vi.mocked(runServeSession).mockImplementation((options) => {
    const child = Object.assign(new ChildProcess(), { pid: 5000 + backends.events.length });
    const messages: Serializable[] = [];
    Object.defineProperty(child, 'connected', { value: true });
    Object.defineProperty(child, 'send', {
      value: (message: Serializable, callback: (error: Error | null) => void) => {
        messages.push(message);
        callback(null);
        return true;
      },
    });
    vi.spyOn(child, 'kill').mockImplementation(() => {
      queueMicrotask(() => exit(child));
      return true;
    });
    return new Promise<void>((resolve, reject) => {
      const stopped = () => {
        cleanup();
        resolve();
      };
      const exited = (code: number | null) => {
        cleanup();
        if (options.signal.aborted || options.isExpectedBackendExit?.()) {
          resolve();
        } else {
          reject(new Error(`Backend startup failed (${code})`));
        }
      };
      const cleanup = () => {
        options.signal.removeEventListener('abort', stopped);
        child.off('exit', exited);
        child.off('error', reject);
      };
      options.signal.addEventListener('abort', stopped, { once: true });
      child.once('exit', exited);
      child.once('error', reject);
      options.onBackend?.(child);
      const listening = options.onReady();
      void listening.catch(reject);
      backends.record({ child, options, messages, listening });
    });
  });
});
afterEach(async () => {
  controller.abort();
  await session?.catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('production serve update integration', () => {
  it('advertises capabilities and waits for the full backend handshake before opening the browser', async () => {
    start();
    const running = await backend();
    expect(onReady).not.toHaveBeenCalled();
    running.child.emit('message', { type: 'update-hello' });
    expect(running.messages).toContainEqual({
      type: 'update-capabilities',
      automaticUpdate: true,
      manualCommand: expect.stringMatching(/npm install.*restart/i),
    });
    expect(running.messages).toContainEqual({ type: 'update-status', status: { phase: 'idle' } });
    expect(onReady).not.toHaveBeenCalled();
    await ready(running);
    expect(onReady).toHaveBeenCalledOnce();
  });

  it('waits for idle work, shuts down gracefully, migrates and restarts with the same launch settings', async () => {
    const original = await requestUpdate(true);
    await original.stopRequested;
    expect(original.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(original.messages).toContainEqual({
      type: 'update-status',
      status: { phase: 'preparing', targetVersion: '0.5.4' },
    });
    expect(original.messages).toContainEqual({
      type: 'update-status',
      status: { phase: 'restarting', targetVersion: '0.5.4' },
    });
    expect(prepared.activate).not.toHaveBeenCalled();
    expect(backends.events).toHaveLength(1);
    exit(original.child);
    const replacement = await backend(1);
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith('0.5.4', expect.any(AbortSignal));
    expect(original.child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(original.child.exitCode).toBe(0);
    expect(await readFile(versionFile, 'utf8')).toBe('0.5.4');
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      process.execPath,
      [join(packageRoot, 'dist/src/cli/index.js'), 'db:migrate', '--database-path', databasePath],
      // The supervisor's own snapshot is the backup, so the migration need not fail closed twice.
      expect.objectContaining({
        env: { ...original.options.env, FF_ALLOW_MIGRATION_WITHOUT_BACKUP: '1' },
      }),
      expect.any(Function)
    );
    expect(original.options.env).not.toHaveProperty('FF_ALLOW_MIGRATION_WITHOUT_BACKUP');
    expect(replacement.options).toMatchObject({
      projectRoot: packageRoot,
      databasePath,
      env: original.options.env,
      host: '0.0.0.0',
      frontendPort: 4321,
      backendPort: 4322,
      verbose: true,
    });
    expect(onReady).toHaveBeenCalledOnce();
    expect(prepared.dispose).not.toHaveBeenCalled();
    await ready(replacement);
    expect(onReady).toHaveBeenCalledOnce();
    expect(prepared.dispose).toHaveBeenCalledOnce();
    expect(replacement.messages).toContainEqual({
      type: 'update-status',
      status: { phase: 'idle' },
    });
    expect(await readdir(directory)).not.toContain('database-backup');
    expect(databaseValue()).toBe('before update');
    // Nothing was pending, so there was no backup to miss: the snapshot went with the stage.
    expect(await preMigrationBackups()).toEqual([]);
    expect(
      (await readdir(directory)).filter((name) =>
        name.startsWith('.factory-factory-database-backup-')
      )
    ).toEqual([]);
  });

  it('stops the update when its own database snapshot fails, without the override rescuing it', async () => {
    await mkdir(join(directory, 'database-backup'));
    await requestUpdate();
    const recovered = await backend(1);
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(prepared.activate).not.toHaveBeenCalled();
    expect(await readFile(versionFile, 'utf8')).toBe('0.5.3');
    expect(databaseValue()).toBe('before update');
    recovered.child.emit('message', { type: 'update-hello' });
    expect(recovered.messages).toContainEqual({
      type: 'update-status',
      status: expect.objectContaining({ phase: 'failed', targetVersion: '0.5.4' }),
    });
  });

  it('restores the database and old installation after migration fails and publishes the failure on reconnect', async () => {
    mocks.migrate.mockImplementation(async () => {
      const database = new Database(databasePath);
      database.exec("UPDATE test_data SET value = 'partially migrated'");
      database.close();
      await writeFile(`${databasePath}-journal`, 'failed migration journal');
      throw new Error('Migration failed');
    });
    await requestUpdate();
    const recovered = await backend(1);
    expect(await readFile(versionFile, 'utf8')).toBe('0.5.3');
    expect(databaseValue()).toBe('before update');
    expect(await readdir(directory)).not.toContain('data.db-journal');
    recovered.child.emit('message', { type: 'update-hello' });
    expect(recovered.messages).toContainEqual({
      type: 'update-status',
      status: expect.objectContaining({
        phase: 'failed',
        targetVersion: '0.5.4',
        error: expect.stringContaining('Migration failed'),
      }),
    });
    await ready(recovered);
    expect(onReady).toHaveBeenCalledOnce();
    expect(prepared.rollback).toHaveBeenCalledOnce();
  });

  it('keeps its snapshot as a hard link in db-backups when the migration left no new backup there', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // The child prints nothing and makes no backup: only the file system decides.
    mocks.migrate.mockImplementation(() => {
      const database = new Database(databasePath);
      database.exec("UPDATE test_data SET value = 'migrated'");
      database.close();
      return Promise.resolve();
    });
    await makeMigrationPending();
    await requestUpdate();
    await ready(await backend(1));

    const kept = await preMigrationBackups();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^data\.db-pre-migration-\d{8}T\d{9}Z\.db$/);
    const keptPath = join(directory, 'db-backups', kept[0] ?? '');
    expect(valueIn(keptPath)).toBe('before update');
    expect((await stat(keptPath)).mode & 0o777).toBe(0o600);
    expect(databaseValue()).toBe('migrated');
    expect(await readdir(directory)).not.toContain('database-backup');
    const logged = error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('made no lasting backup');
    expect(logged).toContain(keptPath);
  });

  it('prunes db-backups like the migration does, never the link it just made, and makes it owner-only', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const backupDirectory = join(directory, 'db-backups');
    await mkdir(backupDirectory, { mode: 0o777 });
    await chmod(backupDirectory, 0o777);
    // Three older backups, and one dated in the future that sorts after the new link.
    const existing = [
      'data.db-pre-migration-20200101T000000000Z.db',
      'data.db-pre-migration-20200102T000000000Z.db',
      'data.db-pre-migration-20200103T000000000Z.db',
      'data.db-pre-migration-29990101T000000000Z.db',
    ];
    for (const name of existing) {
      await writeFile(join(backupDirectory, name), name);
    }
    await makeMigrationPending();
    await requestUpdate();
    await ready(await backend(1));

    const remaining = await preMigrationBackups();
    expect(remaining).toHaveLength(3);
    const linked = remaining.filter((name) => !existing.includes(name));
    expect(linked).toHaveLength(1);
    expect(valueIn(join(backupDirectory, linked[0] ?? ''))).toBe('before update');
    expect(remaining).toContain('data.db-pre-migration-29990101T000000000Z.db');
    expect(remaining).toContain('data.db-pre-migration-20200103T000000000Z.db');
    if (process.platform !== 'win32') {
      expect((await stat(backupDirectory)).mode & 0o777).toBe(0o700);
    }
  });

  it('lets its snapshot go, and leaves db-backups alone, when nothing was pending to migrate', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const backupDirectory = join(directory, 'db-backups');
    await mkdir(backupDirectory);
    const existing = [
      'data.db-pre-migration-20200101T000000000Z.db',
      'data.db-pre-migration-20200102T000000000Z.db',
      'data.db-pre-migration-20200103T000000000Z.db',
    ];
    for (const name of existing) {
      await writeFile(join(backupDirectory, name), name);
    }
    await requestUpdate();
    await ready(await backend(1));

    // The backup taken before the last real migration survives updates without one.
    expect(await preMigrationBackups()).toEqual(existing);
    expect(await readdir(directory)).not.toContain('database-backup');
    expect(error).not.toHaveBeenCalled();
  });

  it('keeps its snapshot when it cannot tell whether migrations are pending', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await rm(join(packageRoot, 'prisma'), { recursive: true });
    await requestUpdate();
    await ready(await backend(1));

    expect(await preMigrationBackups()).toHaveLength(1);
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).toContain('Could not tell whether migrations are pending');
  });

  it('lets its snapshot go when the migration left a new backup in db-backups', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const childBackup = 'data.db-pre-migration-20300101T000000000Z.db';
    mocks.migrate.mockImplementation(async () => {
      await mkdir(join(directory, 'db-backups'), { recursive: true });
      await writeFile(join(directory, 'db-backups', childBackup), 'the child backup');
    });
    await makeMigrationPending();
    await requestUpdate();
    await ready(await backend(1));

    expect(await preMigrationBackups()).toEqual([childBackup]);
    expect(await readdir(directory)).not.toContain('database-backup');
    expect(error).not.toHaveBeenCalled();
  });

  it('links its snapshot beside the package when db-backups cannot be used', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await writeFile(join(directory, 'db-backups'), 'a file where the directory should be');
    await makeMigrationPending();
    await requestUpdate();
    await ready(await backend(1));

    const kept = (await readdir(directory)).filter((name) =>
      name.startsWith('.factory-factory-database-backup-')
    );
    expect(kept).toHaveLength(1);
    const keptPath = join(directory, kept[0] ?? '');
    expect(valueIn(keptPath)).toBe('before update');
    const logged = error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain(keptPath);
    expect(logged).toContain(join(directory, 'db-backups'));
  });

  // Root ignores directory permissions, so the unwritable case needs an ordinary user.
  it.skipIf(process.getuid?.() === 0)(
    'leaves its snapshot in the stage when no link can be made',
    async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const stage = join(directory, 'stage');
      await mkdir(stage);
      // Disposes like the installer: everything in the stage except what it is told to keep.
      const dispose = vi.fn(async (options: { keep?: string } = {}) => {
        for (const name of await readdir(stage)) {
          if (join(stage, name) !== options.keep) {
            await rm(join(stage, name), { recursive: true, force: true });
          }
        }
      });
      prepared = { ...prepared, recoveryPath: join(stage, 'previous'), dispose };
      await writeFile(join(directory, 'db-backups'), 'a file where the directory should be');
      await makeMigrationPending();
      await requestUpdate();
      const replacement = await backend(1);
      // Neither db-backups nor the package's directory accepts a link now.
      await chmod(directory, 0o555);
      try {
        await ready(replacement);
      } finally {
        await chmod(directory, 0o755);
      }

      const snapshot = join(stage, 'database-backup');
      expect(dispose).toHaveBeenCalledWith({ keep: snapshot });
      expect(valueIn(snapshot)).toBe('before update');
      const logged = error.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('made no lasting backup');
      expect(logged).toContain(`kept at ${snapshot}`);
    }
  );

  it('never replaces an earlier backup that has the name its snapshot would take', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-27T10:15:00.123Z') });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await mkdir(join(directory, 'db-backups'));
    const earlier = join(directory, 'db-backups', 'data.db-pre-migration-20261127T101500123Z.db');
    await writeFile(earlier, 'earlier backup');
    try {
      await makeMigrationPending();
      await requestUpdate();
      await ready(await backend(1));
    } finally {
      vi.useRealTimers();
    }

    expect(await readFile(earlier, 'utf8')).toBe('earlier backup');
    expect(await preMigrationBackups()).toEqual([
      'data.db-pre-migration-20261127T101500123Z.db',
      'data.db-pre-migration-20261127T101500124Z.db',
    ]);
  });

  it('keeps no extra snapshot when the replacement fails and the update is rolled back', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await requestUpdate();
    exit((await backend(1)).child, 1);
    const recovered = await backend(2);
    await ready(recovered);

    expect(prepared.rollback).toHaveBeenCalledOnce();
    expect(databaseValue()).toBe('before update');
    expect(await preMigrationBackups()).toEqual([]);
    expect(
      (await readdir(directory)).filter((name) =>
        name.startsWith('.factory-factory-database-backup-')
      )
    ).toEqual([]);
    const logged = error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).not.toContain('made no lasting backup');
  });

  it("puts the last line of the db:migrate child's error output first in the failed update", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // The override's warning comes first and alone would fill the banner.
    const warning =
      '[migrate] Warning: migrating without a backup: could not back up the database to ' +
      '/data/db-backups: ENOSPC: no space left on device. Continuing because ' +
      'FF_ALLOW_MIGRATION_WITHOUT_BACKUP=1.';
    const reason =
      'Migration failed: Failed to apply migration 002_posts: near "TABL": syntax error';
    mocks.migrateStderr = `${warning}\n${reason}\n`;
    // How Node's execFile reports a nonzero exit: the whole command line comes first.
    const command = [
      process.execPath,
      join(packageRoot, 'dist/src/cli/index.js'),
      'db:migrate',
      '--database-path',
      databasePath,
    ].join(' ');
    mocks.migrate.mockRejectedValue(
      new Error(`Command failed: ${command}\n${warning}\n${reason}\n`)
    );
    await requestUpdate();
    const recovered = await backend(1);
    expect(databaseValue()).toBe('before update');

    const failure = failedUpdateError(recovered);
    // The update banner shows the first 240 characters.
    expect(failure.slice(0, 240)).toContain('near "TABL": syntax error');
    expect(failure).toContain('ENOSPC');
    expect(failure).not.toContain('Command failed');
    const logged = error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain(reason);
    expect(logged).toContain(warning);
  });

  it.each([
    {
      case: 'an uncaught crash, whose output ends with a stack and the Node.js version',
      stderr:
        'file:///pkg/dist/src/cli/index.js:10\n    throw error;\n    ^\n\n' +
        "TypeError: Cannot read properties of undefined (reading 'path')\n" +
        '    at main (file:///pkg/dist/src/cli/index.js:10:5)\n\nNode.js v24.0.0\n',
      cause: "TypeError: Cannot read properties of undefined (reading 'path')",
    },
    {
      case: 'unknown applied migrations, whose output ends with advice',
      stderr:
        'The database at /data/data.db was updated by a newer version of Factory Factory.\n' +
        '  If these migrations came from a development branch that shares this database, ' +
        'set FF_ALLOW_UNKNOWN_MIGRATIONS=1 to start anyway.\n',
      cause: 'The database at /data/data.db was updated by a newer version of Factory Factory.',
    },
  ])('leads the failed update with the cause for $case', async ({ stderr, cause }) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.migrateStderr = stderr;
    mocks.migrate.mockRejectedValue(new Error('Command failed'));
    await requestUpdate();

    expect(failedUpdateError(await backend(1)).split('\n')[0]).toBe(
      `Could not update Factory Factory. The database migration failed: ${cause}`
    );
  });

  it('stores a bounded failure message however long the child output, and logs all of it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const noise = `${'progress line\n'.repeat(80_000)}`;
    mocks.migrateStderr = `${noise}Migration failed: boom\n`;
    mocks.migrate.mockRejectedValue(new Error('Command failed'));
    await requestUpdate();
    const recovered = await backend(1);

    const failure = failedUpdateError(recovered);
    expect(failure.length).toBeLessThanOrEqual(4096 + 'Could not update Factory Factory. '.length);
    expect(failure).toContain('Migration failed: boom');
    // The journal is refused above 64 KiB, so what is persisted stays far below it.
    const persisted = mocks.persist.mock.calls.map((call) => JSON.stringify(call[0]));
    expect(Math.max(...persisted.map((text) => text.length))).toBeLessThan(16 * 1024);
    const logged = error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged.length).toBeGreaterThan(noise.length);
  });

  it('restores and restarts the previous installation after replacement boot fails', async () => {
    mocks.migrate.mockImplementation(() => {
      const database = new Database(databasePath);
      database.exec("UPDATE test_data SET value = 'migration succeeded'");
      database.close();
      return Promise.resolve();
    });
    await requestUpdate();
    const replacement = await backend(1);
    exit(replacement.child, 1);
    const recovered = await backend(2);
    expect(await readFile(versionFile, 'utf8')).toBe('0.5.3');
    expect(databaseValue()).toBe('before update');
    recovered.child.emit('message', { type: 'update-hello' });
    expect(recovered.messages).toContainEqual({
      type: 'update-status',
      status: expect.objectContaining({
        phase: 'failed',
        error: expect.stringContaining('Backend startup failed'),
      }),
    });
    await ready(recovered);
    expect(onReady).toHaveBeenCalledOnce();
    expect(prepared.rollback).toHaveBeenCalledOnce();
  });

  it('keeps unsupported installations usable with manual guidance and no update files', async () => {
    mocks.supported = false;
    const entries = await readdir(directory);
    start();
    const running = await backend();
    running.child.emit('message', { type: 'update-hello' });
    expect(running.messages).toContainEqual({
      type: 'update-capabilities',
      automaticUpdate: false,
      manualCommand: expect.stringMatching(/restart/i),
    });
    running.child.emit('message', { type: 'update-request', version: '0.5.4' });
    running.child.emit('message', { type: 'update-ready' });
    expect(running.messages).toContainEqual({
      type: 'update-status',
      status: expect.objectContaining({ phase: 'failed', error: expect.stringMatching(/manual/i) }),
    });
    await ready(running);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual(entries);
    expect(onReady).toHaveBeenCalledOnce();
  });

  it('leaves development serve behavior and installation files untouched', async () => {
    const entries = await readdir(directory);
    start(true);
    const running = await backend();
    await running.listening;
    expect(running.options.onBackend).toBeUndefined();
    expect(mocks.constructed).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual(entries);
    expect(onReady).toHaveBeenCalledOnce();
  });
});

it('disables automatic installation while another app server is running', async () => {
  mocks.otherServers = true;
  start();
  const running = await backend();
  running.child.emit('message', { type: 'update-hello' });
  expect(running.messages).toContainEqual(
    expect.objectContaining({ type: 'update-capabilities', automaticUpdate: false })
  );
  await ready(running);
  running.child.emit('message', { type: 'update-request', version: '0.5.4' });
  running.child.emit('message', { type: 'update-ready' });
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(running.messages).toContainEqual({
    type: 'update-status',
    status: expect.objectContaining({ phase: 'failed', error: expect.stringMatching(/manual/i) }),
  });
});
