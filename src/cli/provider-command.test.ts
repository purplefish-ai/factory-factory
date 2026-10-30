import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runClaudeCommand } from './claude';
import { runCodexCommand } from './codex';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn,
}));
vi.mock('@/backend/services/logger.service', () => ({ getCurrentProcessEnv: () => ({}) }));
vi.mock('@/backend/lib/node-runtime', () => ({ getNodeExecPath: () => process.execPath }));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.skipIf(process.platform === 'win32').each([runClaudeCommand, runCodexCommand])(
  'cleans up surviving native descendants even when the launcher exits first',
  async (run) => {
    let alive = true;
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (!alive) {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
      if (signal === 'SIGKILL') {
        alive = false;
      }
      return true;
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 424_242,
      exitCode: null as number | null,
      signalCode: null,
      kill: vi.fn(),
    });
    spawn.mockReturnValue(child);
    const pending = run(['--help']);
    const signal = process.listeners('SIGTERM').at(-1);
    signal?.('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    child.exitCode = 0;
    child.emit('exit', 0);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(false);
    signal?.('SIGTERM');
    await vi.advanceTimersByTimeAsync(3000);
    await expect(pending).resolves.toBe(0);
    expect(kill).toHaveBeenCalledWith(-424_242, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(-424_242, 'SIGKILL');
    expect(kill.mock.calls.filter(([, value]) => value === 'SIGTERM')).toHaveLength(1);
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ detached: true })
    );
  }
);

it.skipIf(process.platform === 'win32').each([runClaudeCommand, runCodexCommand])(
  'cancels escalation when the provider group exits',
  async (run) => {
    let alive = true;
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (!alive) {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
      if (signal === 'SIGINT') {
        alive = false;
      }
      return true;
    });
    const child = Object.assign(new EventEmitter(), { pid: 424_242, kill: vi.fn() });
    spawn.mockReturnValue(child);
    const before = process.listenerCount('SIGINT');
    const pending = run(['--help']);
    process.listeners('SIGINT').at(-1)?.('SIGINT');
    await vi.advanceTimersByTimeAsync(0);
    child.emit('exit', 0);
    await expect(pending).resolves.toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(kill).not.toHaveBeenCalledWith(-424_242, 'SIGKILL');
    expect(process.listenerCount('SIGINT')).toBe(before);
  }
);

it.skipIf(process.platform === 'win32').each([runClaudeCommand, runCodexCommand])(
  'forwards terminal resize to the owned group and removes its listener',
  async (run) => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const child = Object.assign(new EventEmitter(), { pid: 424_242, kill: vi.fn() });
    spawn.mockReturnValue(child);
    const before = process.listenerCount('SIGWINCH');
    const pending = run(['--help']);
    try {
      expect(process.listenerCount('SIGWINCH')).toBe(before + 1);
      process.listeners('SIGWINCH').at(-1)?.('SIGWINCH');
      expect(kill).toHaveBeenCalledWith(-424_242, 'SIGWINCH');
    } finally {
      child.emit('exit', 0);
      await pending;
    }
    expect(process.listenerCount('SIGWINCH')).toBe(before);
  }
);

it.skipIf(process.platform === 'win32').each([runClaudeCommand, runCodexCommand])(
  'cleans surviving descendants after abnormal launcher exit',
  async (run) => {
    let alive = true;
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (!alive) {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
      if (signal === 'SIGKILL') {
        alive = false;
      }
      return true;
    });
    const child = Object.assign(new EventEmitter(), { pid: 424_242, kill: vi.fn() });
    spawn.mockReturnValue(child);
    const pending = run(['--help']);
    child.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toBe(1);
    expect(kill).toHaveBeenCalledWith(-424_242, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(-424_242, 'SIGKILL');
  }
);

it.skipIf(process.platform === 'win32').each([runClaudeCommand, runCodexCommand])(
  'preserves native background-job semantics after successful completion',
  async (run) => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const child = Object.assign(new EventEmitter(), { pid: 424_242, kill: vi.fn() });
    spawn.mockReturnValue(child);
    const pending = run(['--help']);
    child.emit('exit', 0, null);
    await expect(pending).resolves.toBe(0);
    expect(kill).not.toHaveBeenCalled();
  }
);

it.skipIf(process.platform === 'win32').each([runClaudeCommand, runCodexCommand])(
  'preserves provider status when process cleanup fails',
  async (run) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    for (const outcome of [
      { code: 7, signal: null, interrupt: false, status: 7 },
      { code: null, signal: 'SIGTERM', interrupt: false, status: 143 },
      { code: 0, signal: null, interrupt: true, status: 0 },
    ]) {
      const child = Object.assign(new EventEmitter(), { pid: 424_242, kill: vi.fn() });
      spawn.mockReturnValue(child);
      const before = process.listenerCount('SIGTERM');
      const pending = run(['--help']);
      if (outcome.interrupt) {
        process.listeners('SIGTERM').at(-1)?.('SIGTERM');
        await vi.advanceTimersByTimeAsync(0);
      }
      child.emit('exit', outcome.code, outcome.signal);
      // A persistent EPERM is reported as a failure once the cleanup budget expires.
      const settled = expect(pending).resolves.toBe(outcome.status);
      await vi.advanceTimersByTimeAsync(5000);
      await settled;
      expect(process.listenerCount('SIGTERM')).toBe(before);
    }
    expect(log).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledWith('Could not clean up provider processes:', expect.any(Error));
  }
);
