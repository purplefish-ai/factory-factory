import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { fetchCodexPlanUsage } from './codex-plan-usage-loader';
import * as usageSpawn from './codex-plan-usage-spawn';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, execFile: mocks.execFile }));

const requestSchema = z.object({ id: z.number().optional(), method: z.string() });
let methods: string[];
let account: unknown;
let usage: unknown;
let stopAt: string | undefined;
let rejectAt: string | undefined;
let diagnostic: boolean;

function resultForMethod(method: string): unknown {
  if (method === 'initialize') {
    return {};
  }
  if (method === 'account/read') {
    return { account, requiresOpenaiAuth: true };
  }
  return usage;
}

beforeEach(() => {
  methods = [];
  account = { type: 'chatgpt', email: 'private@example.com', planType: 'pro' };
  usage = {
    rateLimits: { primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: 1_800_000_000 } },
    rateLimitsByLimitId: null,
  };
  stopAt = undefined;
  rejectAt = undefined;
  diagnostic = false;
  mocks.spawn.mockReset();
  mocks.execFile.mockReset();
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: vi.fn(() => {
        child.signalCode = 'SIGTERM';
        child.emit('exit');
        return true;
      }),
    });
    child.stdin.on('data', (chunk: Buffer) => {
      const request = requestSchema.parse(JSON.parse(chunk.toString()));
      methods.push(request.method);
      if (request.id === undefined || request.method === stopAt) {
        return;
      }
      queueMicrotask(() => {
        if (diagnostic) {
          child.stdout.write('startup diagnostic\n');
        }
        if (request.method === rejectAt) {
          child.stdout.write(
            `${JSON.stringify({ id: request.id, error: { code: -1, message: 'private credential' } })}\n`
          );
          return;
        }
        const result = resultForMethod(request.method);
        child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      });
    });
    return child;
  });
});

afterEach(() => vi.useRealTimers());

it('reads real ChatGPT quota without creating threads or model turns and closes its own process', async () => {
  await expect(fetchCodexPlanUsage()).resolves.toEqual({
    status: 'available',
    windows: [
      { id: 'codex:primary', label: '5-hour window', usedPercent: 11, resetsAt: 1_800_000_000 },
    ],
  });
  expect(methods).toEqual(['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
  expect(mocks.spawn).toHaveBeenCalledWith(
    process.execPath,
    [expect.stringContaining('codex-acp'), 'cli', 'app-server'],
    expect.objectContaining({
      cwd: tmpdir(),
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  );
  expect(mocks.spawn.mock.results[0]?.value.kill).toHaveBeenCalledWith('SIGTERM');
});

it.each([null, { type: 'apiKey' }, { type: 'amazonBedrock', usesCodexManagedCredentials: true }])(
  'returns unavailable for non-ChatGPT authentication %j',
  async (value) => {
    account = value;
    await expect(fetchCodexPlanUsage()).resolves.toEqual({ status: 'unavailable', windows: [] });
    expect(methods).toEqual(['initialize', 'initialized', 'account/read']);
    expect(mocks.spawn.mock.results[0]?.value.kill).toHaveBeenCalledWith('SIGTERM');
  }
);

it('uses all quota buckets from the native response', async () => {
  usage = {
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 25, windowDurationMins: 300 },
        secondary: { usedPercent: 50, windowDurationMins: 10_080 },
      },
    },
  };
  await expect(fetchCodexPlanUsage()).resolves.toEqual({
    status: 'available',
    windows: [
      { id: 'codex:primary', label: '5-hour window', usedPercent: 25, resetsAt: null },
      { id: 'codex:secondary', label: 'Weekly', usedPercent: 50, resetsAt: null },
    ],
  });
});

it('rejects malformed quota and terminates the disposable process', async () => {
  usage = { rateLimits: { primary: { usedPercent: 'unknown' } } };
  await expect(fetchCodexPlanUsage()).rejects.toThrow();
  expect(mocks.spawn.mock.results[0]?.value.kill).toHaveBeenCalledWith('SIGTERM');
});

it('rejects malformed account responses before reading quota', async () => {
  account = { type: 42 };
  await expect(fetchCodexPlanUsage()).rejects.toThrow();
  expect(methods).not.toContain('account/rateLimits/read');
  expect(mocks.spawn.mock.results[0]?.value.kill).toHaveBeenCalledWith('SIGTERM');
});

it('sanitizes native RPC errors and terminates its process', async () => {
  rejectAt = 'account/rateLimits/read';
  await expect(fetchCodexPlanUsage()).rejects.toThrow('Codex plan usage request failed');
  expect(mocks.spawn.mock.results[0]?.value.kill).toHaveBeenCalledWith('SIGTERM');
});

it('ignores startup diagnostics and drains stderr without exposing it', async () => {
  diagnostic = true;
  const reading = fetchCodexPlanUsage();
  const child = mocks.spawn.mock.results[0]?.value;
  child.stderr.write('private credential');
  await expect(reading).resolves.toMatchObject({ status: 'available' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(child.stderr.readableLength).toBe(0);
});

it('bounds a stalled native read and closes its process', async () => {
  vi.useFakeTimers();
  stopAt = 'account/read';
  const reading = fetchCodexPlanUsage();
  const rejected = expect(reading).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  expect(mocks.spawn.mock.results[0]?.value.kill).toHaveBeenCalledWith('SIGTERM');
  expect(methods).not.toContain('account/rateLimits/read');
});

it('fails promptly and cleans up when its child process errors', async () => {
  stopAt = 'initialize';
  const reading = fetchCodexPlanUsage();
  mocks.spawn.mock.results[0]?.value.emit('error', new Error('private spawn detail'));
  await expect(reading).rejects.toThrow('Codex plan usage process failed');
  expect(mocks.spawn.mock.results[0]?.value.kill).toHaveBeenCalledWith('SIGTERM');
});

it('force-kills an unresponsive disposable process within the total deadline', async () => {
  vi.useFakeTimers();
  stopAt = 'initialize';
  const reading = fetchCodexPlanUsage();
  const rejected = expect(reading).rejects.toThrow('timed out');
  const child = mocks.spawn.mock.results[0]?.value;
  child.kill.mockImplementation(() => true);
  await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
});

it('rejects a pending read when the native process exits', async () => {
  stopAt = 'initialize';
  const reading = fetchCodexPlanUsage();
  const child = mocks.spawn.mock.results[0]?.value;
  child.exitCode = 1;
  child.emit('exit');
  await expect(reading).rejects.toThrow('Codex plan usage process exited');
});

it('terminates descendants when the launcher has exited but inherited pipes remain open', async () => {
  vi.useFakeTimers();
  stopAt = 'initialize';
  const groupKill = vi.spyOn(process, 'kill').mockReturnValue(true);
  try {
    const reading = fetchCodexPlanUsage();
    const rejected = expect(reading).rejects.toThrow('Codex plan usage process exited');
    const child = mocks.spawn.mock.results[0]?.value;
    child.pid = 424_242;
    child.exitCode = 1;
    child.emit('exit');
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(groupKill).toHaveBeenCalledWith(-424_242, 'SIGTERM');
    expect(groupKill).toHaveBeenCalledWith(-424_242, 'SIGKILL');
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  } finally {
    groupKill.mockRestore();
  }
});

it('finishes graceful process-group cleanup when no descendants remain', async () => {
  const groupKill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 0) {
      throw Object.assign(new Error('No process'), { code: 'ESRCH' });
    }
    return true;
  });
  try {
    const reading = fetchCodexPlanUsage();
    const child = mocks.spawn.mock.results[0]?.value;
    child.pid = 424_242;
    await expect(reading).resolves.toMatchObject({ status: 'available' });
    expect(groupKill.mock.calls).toEqual([
      [-424_242, 'SIGTERM'],
      [-424_242, 0],
    ]);
    expect(child.stdout.destroyed).toBe(true);
  } finally {
    groupKill.mockRestore();
  }
});

it('bounds stalled quota reads including process-group force termination', async () => {
  vi.useFakeTimers();
  stopAt = 'initialize';
  const groupKill = vi.spyOn(process, 'kill').mockReturnValue(true);
  try {
    const reading = fetchCodexPlanUsage();
    const rejected = expect(reading).rejects.toThrow('timed out');
    const child = mocks.spawn.mock.results[0]?.value;
    child.pid = 424_242;
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(groupKill).toHaveBeenCalledWith(-424_242, 'SIGTERM');
    expect(groupKill).toHaveBeenCalledWith(-424_242, 'SIGKILL');
    expect(child.stdout.destroyed).toBe(true);
  } finally {
    groupKill.mockRestore();
  }
});

it('uses bounded Windows tree termination for the directly owned native runtime', async () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!platformDescriptor) {
    throw new Error('Missing process platform');
  }
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const resolveSpawn = vi.spyOn(usageSpawn, 'resolveCodexPlanUsageSpawnCommand').mockReturnValue({
    command: 'C:\u005ccodex.exe',
    args: ['app-server'],
    commandLabel: 'codex app-server',
  });
  mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
    const child = mocks.spawn.mock.results[0]?.value;
    child.exitCode = 0;
    child.emit('exit');
    callback(null);
  });
  try {
    const reading = fetchCodexPlanUsage();
    const child = mocks.spawn.mock.results[0]?.value;
    child.pid = 424_242;
    await expect(reading).resolves.toMatchObject({ status: 'available' });
    expect(mocks.spawn).toHaveBeenCalledWith(
      'C:\u005ccodex.exe',
      ['app-server'],
      expect.objectContaining({ detached: false, windowsHide: true })
    );
    expect(mocks.execFile).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '424242', '/T', '/F'],
      { timeout: 4000, windowsHide: true },
      expect.any(Function)
    );
  } finally {
    resolveSpawn.mockRestore();
    Object.defineProperty(process, 'platform', platformDescriptor);
  }
});
