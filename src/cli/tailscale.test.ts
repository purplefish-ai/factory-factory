import { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationBackupError, runMigrationsWithBackup } from '@/backend/migrate-with-backup';
import { describeMigrationFailure } from './migration-policy';
import { findAvailablePort, treeKillAsync } from './runtime-utils';
import { startFactoryFactoryServer } from './server-startup';
import { registerTailscaleCommand, runTailscaleSession } from './tailscale';
import { discoverTailscale } from './tailscale-client';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('@/backend/migrate-with-backup', async (original) => ({
  ...(await original<typeof import('@/backend/migrate-with-backup')>()),
  runMigrationsWithBackup: vi.fn(),
}));
vi.mock('./server-startup', () => ({ startFactoryFactoryServer: vi.fn() }));
vi.mock('./tailscale-client', () => ({ discoverTailscale: vi.fn(), parsePort: Number }));
vi.mock('./runtime-utils', () => ({
  ensureDataDir: vi.fn(),
  findAvailablePort: vi.fn().mockResolvedValue(3002),
  treeKillAsync: vi.fn(),
}));
vi.mock('qrcode', () => ({ toString: vi.fn().mockResolvedValue('QR') }));

const options = { backendPort: 3001, httpsPort: 443 };
let backend: ChildProcess;
let serve: ChildProcess;
let serveSpawned: Promise<void>;
function child(pid: number): ChildProcess {
  return Object.assign(new ChildProcess(), {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
}
function exit(proc: ChildProcess, code = 0) {
  Object.defineProperty(proc, 'exitCode', { value: code, configurable: true });
  proc.emit('exit', code, null);
}
beforeEach(() => {
  backend = child(1234);
  serve = child(1235);
  vi.mocked(discoverTailscale).mockResolvedValue('https://mac.tail123.ts.net');
  vi.mocked(startFactoryFactoryServer).mockResolvedValue({ process: backend, port: 3007 });
  const spawned = Promise.withResolvers<void>();
  serveSpawned = spawned.promise;
  vi.mocked(spawn).mockImplementation(() => {
    spawned.resolve();
    return serve;
  });
  vi.mocked(treeKillAsync).mockImplementation((pid) => {
    exit(pid === backend.pid ? backend : serve);
    return Promise.resolve();
  });
  vi.spyOn(console, 'log').mockImplementation(() => {
    /* Keep test output quiet. */
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('owned Tailscale session', () => {
  it('forwards the actual backend port with foreground Serve and cleans up on abort', async () => {
    const controller = new AbortController();
    const result = runTailscaleSession({
      projectRoot: '/project',
      options,
      signal: controller.signal,
    });
    await serveSpawned;
    expect(findAvailablePort).toHaveBeenCalledWith(3001, {
      maxAttempts: 50,
      signal: controller.signal,
    });
    expect(startFactoryFactoryServer).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedPort: 3002,
        tailscale: { origin: 'https://mac.tail123.ts.net', httpsPort: 443 },
        signal: controller.signal,
      })
    );
    expect(spawn).toHaveBeenCalledWith(
      'tailscale',
      ['serve', '--https=443', 'http://127.0.0.1:3007'],
      { stdio: ['inherit', 'pipe', 'pipe'] }
    );
    controller.abort();
    await result;
    expect(treeKillAsync).toHaveBeenCalledWith(1234, 'SIGTERM');
    expect(treeKillAsync).toHaveBeenCalledWith(1235, 'SIGTERM');
  });
  it('stops the server if Serve exits, including a successful early exit', async () => {
    const result = runTailscaleSession({
      projectRoot: '/project',
      options,
      signal: new AbortController().signal,
    });
    const assertion = expect(result).rejects.toThrow(/Tailscale Serve.*exited/);
    await serveSpawned;
    exit(serve);
    await assertion;
    expect(treeKillAsync).toHaveBeenCalledWith(1234, 'SIGTERM');
  });
  it('stops Serve if the backend crashes', async () => {
    const result = runTailscaleSession({
      projectRoot: '/project',
      options,
      signal: new AbortController().signal,
    });
    const assertion = expect(result).rejects.toThrow(/Factory Factory.*exited/);
    await serveSpawned;
    exit(backend, 1);
    await assertion;
    expect(treeKillAsync).toHaveBeenCalledWith(1235, 'SIGTERM');
  });
  it('cleans up on a Serve spawn error', async () => {
    const result = runTailscaleSession({
      projectRoot: '/project',
      options,
      signal: new AbortController().signal,
    });
    const assertion = expect(result).rejects.toThrow(/Tailscale Serve.*ENOENT/);
    await serveSpawned;
    serve.emit('error', new Error('ENOENT'));
    await assertion;
    expect(treeKillAsync).toHaveBeenCalledWith(1234, 'SIGTERM');
  });
  it('does not start an instance if discovery or conflict checks fail', async () => {
    vi.mocked(discoverTailscale).mockRejectedValue(new Error('port occupied'));
    await expect(
      runTailscaleSession({
        projectRoot: '/project',
        options,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('port occupied');
    expect(startFactoryFactoryServer).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
  it('does not start Serve after cancellation during server startup', async () => {
    const controller = new AbortController();
    vi.mocked(startFactoryFactoryServer).mockImplementation(() => {
      controller.abort();
      return Promise.resolve({ process: backend, port: 3007 });
    });
    await runTailscaleSession({ projectRoot: '/project', options, signal: controller.signal });
    expect(spawn).not.toHaveBeenCalled();
    expect(treeKillAsync).toHaveBeenCalledWith(1234, 'SIGTERM');
  });
});

describe('tailscale command', () => {
  it('reports a failed pre-migration backup the way the other commands do', async () => {
    const failure = new MigrationBackupError('ENOSPC: no space left on device', '/data/db-backups');
    vi.mocked(runMigrationsWithBackup).mockRejectedValue(failure);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const program = new Command().exitOverride();
    registerTailscaleCommand(program, '/project');
    const previousExitCode = process.exitCode;

    try {
      await program.parseAsync(['tailscale', '--database-path', '/nonexistent/ff/data.db'], {
        from: 'user',
      });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }

    const printed = error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain(describeMigrationFailure(failure));
    expect(printed).not.toContain('MigrationBackupError');
    expect(startFactoryFactoryServer).not.toHaveBeenCalled();
  });
});
