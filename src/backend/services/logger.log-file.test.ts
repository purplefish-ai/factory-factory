import { appendFileSync, existsSync, openSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spy on the real file system so a regression is visible without mocking the
// guard away. HOME points at a temporary directory, so even a regression
// cannot reach a developer's real ~/factory-factory/logs/server.log.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    appendFileSync: vi.fn(actual.appendFileSync),
    openSync: vi.fn(actual.openSync),
    // Swallow the fatal stderr fallback instead of printing it into the run.
    writeSync: vi.fn((_fd: number, _bytes: Uint8Array, _offset: number, length: number) => length),
  };
});

type LoggerModule = typeof import('./logger.service');

const temporaryDirectories: string[] = [];
let home: string;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

async function loadFreshLogger(): Promise<LoggerModule> {
  vi.resetModules();
  return await vi.importActual<LoggerModule>('./logger.service');
}

function logEverything(logger: LoggerModule): void {
  const log = logger.createLogger('log-file-guard');
  log.info('fixture info');
  log.error('fixture error');
  log.fatal('fixture fatal', new Error('fixture cause'));
}

beforeEach(async () => {
  home = await makeTempDir('ff-logger-home-');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('BASE_DIR', undefined);
  vi.stubEnv('LOG_LEVEL', 'info');
  vi.stubEnv('NODE_ENV', 'test');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe('log file in test processes', () => {
  it('never opens the default log without an explicit BASE_DIR', async () => {
    const logger = await loadFreshLogger();

    logEverything(logger);

    expect(openSync).not.toHaveBeenCalled();
    expect(appendFileSync).not.toHaveBeenCalled();
    expect(existsSync(join(home, 'factory-factory'))).toBe(false);
    // The fatal record still survives through the synchronous stderr fallback.
    expect(writeSync).toHaveBeenCalledWith(2, expect.any(Buffer), 0, expect.any(Number));
    expect(logger.getLogFilePath()).toBe(join(home, 'factory-factory', 'logs', 'server.log'));
  });

  it('keeps the guard when a test overrides NODE_ENV inside Vitest', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', 'true');
    const logger = await loadFreshLogger();

    logEverything(logger);

    expect(openSync).not.toHaveBeenCalled();
    expect(appendFileSync).not.toHaveBeenCalled();
    expect(existsSync(join(home, 'factory-factory'))).toBe(false);
  });

  it('refuses an inherited BASE_DIR outside the temp directory', async () => {
    const outside = join(process.cwd(), 'node_modules', '.cache', `ff-logger-guard-${process.pid}`);
    temporaryDirectories.push(outside);
    vi.stubEnv('BASE_DIR', outside);
    const logger = await loadFreshLogger();

    logEverything(logger);

    expect(openSync).not.toHaveBeenCalled();
    expect(appendFileSync).not.toHaveBeenCalled();
    expect(existsSync(outside)).toBe(false);
  });

  it('writes to an explicit temporary BASE_DIR', async () => {
    const baseDir = await makeTempDir('ff-logger-base-');
    vi.stubEnv('BASE_DIR', baseDir);
    const logger = await loadFreshLogger();
    const path = join(baseDir, 'logs', 'server.log');

    logger.createLogger('log-file-guard').info('fixture info');

    expect(logger.getLogFilePath()).toBe(path);
    await vi.waitFor(async () => expect(await readFile(path, 'utf8')).toContain('fixture info'));
  });
});

describe('cleanupOldLogFiles', () => {
  it('removes stale rotated server logs and keeps the current file', async () => {
    const baseDir = await makeTempDir('ff-logger-cleanup-');
    vi.stubEnv('BASE_DIR', baseDir);
    const logsDir = join(baseDir, 'logs');
    const path = join(logsDir, 'server.log');
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await mkdir(logsDir, { recursive: true });
    for (const file of [path, `${path}.1`, `${path}.2`]) {
      await writeFile(file, 'record\n');
    }
    await utimes(path, stale, stale);
    await utimes(`${path}.2`, stale, stale);
    const logger = await loadFreshLogger();

    expect(await logger.cleanupOldLogFiles()).toBe(1);

    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(`${path}.2`)).toBe(false);
  });

  it('does nothing in a test process without an explicit BASE_DIR', async () => {
    const logger = await loadFreshLogger();

    expect(await logger.cleanupOldLogFiles()).toBe(0);
  });
});
