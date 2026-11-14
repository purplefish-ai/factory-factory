import { ChildProcess, execFile, type Serializable } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
let backends: RunningBackend[];
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

async function backend(index = 0) {
  await vi.waitFor(() => expect(backends.length).toBeGreaterThan(index));
  return backends[index]!;
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
  if (holdExit) {
    vi.mocked(original.child.kill).mockReturnValue(true);
  }
  original.child.emit('message', { type: 'update-ready' });
  await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce());
  return original;
}

beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), 'ff-supervised-serve-'));
  packageRoot = join(directory, 'factory-factory');
  versionFile = join(directory, 'installed-version');
  databasePath = join(directory, 'data.db');
  await writeFile(versionFile, '0.5.3');
  const database = new Database(databasePath);
  database.exec(
    "CREATE TABLE test_data(value TEXT); INSERT INTO test_data VALUES ('before update');"
  );
  database.close();
  controller = new AbortController();
  backends = [];
  session = undefined;
  mocks.supported = true;
  mocks.otherServers = false;
  mocks.persist.mockResolvedValue();
  mocks.migrate.mockResolvedValue();
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
  mocks.prepare.mockResolvedValue(prepared);
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      void mocks.migrate().then(
        () => callback(null, '', ''),
        (error: unknown) => callback(error)
      );
    }
    return new ChildProcess();
  });
  vi.mocked(runServeSession).mockImplementation((options) => {
    const child = Object.assign(new ChildProcess(), { pid: 5000 + backends.length });
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
      backends.push({ child, options, messages, listening });
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
    await vi.waitFor(() => expect(original.child.kill).toHaveBeenCalledWith('SIGTERM'));
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
    expect(backends).toHaveLength(1);
    exit(original.child);
    const replacement = await backend(1);
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith('0.5.4', expect.any(AbortSignal));
    expect(original.child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(original.child.exitCode).toBe(0);
    expect(await readFile(versionFile, 'utf8')).toBe('0.5.4');
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      process.execPath,
      [join(packageRoot, 'dist/src/cli/index.js'), 'db:migrate', '--database-path', databasePath],
      expect.objectContaining({ env: original.options.env }),
      expect.any(Function)
    );
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
