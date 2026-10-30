import { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { treeKillAsync } from './runtime-utils';
import { startFactoryFactoryServer } from './server-startup';
import { runTailscaleSession } from './tailscale';
import { discoverTailscale } from './tailscale-client';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('@/backend/migrate', () => ({ runMigrations: vi.fn() }));
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
  vi.mocked(spawn).mockReturnValue(serve);
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

async function started() {
  await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
}

describe('owned Tailscale session', () => {
  it('forwards the actual backend port with foreground Serve and cleans up on abort', async () => {
    const controller = new AbortController();
    const result = runTailscaleSession({
      projectRoot: '/project',
      options,
      signal: controller.signal,
    });
    await started();
    expect(startFactoryFactoryServer).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedPort: 3002,
        trustedProxyOrigin: 'https://mac.tail123.ts.net',
        signal: controller.signal,
      })
    );
    expect(spawn).toHaveBeenCalledWith(
      'tailscale',
      ['serve', '--https=443', 'http://127.0.0.1:3007'],
      expect.anything()
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
    await started();
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
    await started();
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
    await started();
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
