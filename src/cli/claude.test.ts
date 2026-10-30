import { EventEmitter } from 'node:events';
import { Command } from 'commander';
import { expect, it, vi } from 'vitest';
import { getBundledClaudeCommand } from '@/backend/lib/claude-cli-command';
import { registerClaudeCommand, runClaudeCommand } from './claude';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('@/backend/services/logger.service', () => ({
  getCurrentProcessEnv: () => ({ FACTORY_RUNTIME: 'preserved' }),
}));

it('requests the native Claude version instead of the ACP wrapper version', () => {
  expect(getBundledClaudeCommand(['--version']).args.slice(-2)).toEqual(['--cli', '--version']);
});

it.each([['--version'], ['--help'], ['auth', 'login', '--console']])(
  'passes native CLI arguments through Commander: %s',
  async (...args) => {
    const program = new Command().version('app-version').exitOverride();
    const run = vi.fn().mockResolvedValue(0);
    registerClaudeCommand(program, run);
    await program.parseAsync(['node', 'ff', 'claude', ...args]);
    expect(run).toHaveBeenCalledWith(args);
  }
);

it('forwards login arguments to the managed runtime and preserves its exit status', async () => {
  const child = new EventEmitter();
  mocks.spawn.mockImplementation(() => {
    queueMicrotask(() => child.emit('exit', 7));
    return child;
  });
  await expect(runClaudeCommand(['auth', 'login', '--console'])).resolves.toBe(7);
  expect(mocks.spawn).toHaveBeenCalledWith(
    process.platform === 'win32' ? expect.stringMatching(/claude\.exe$/) : process.execPath,
    process.platform === 'win32'
      ? ['auth', 'login', '--console']
      : [expect.stringContaining('claude-agent-acp'), '--cli', 'auth', 'login', '--console'],
    expect.objectContaining({
      stdio: 'inherit',
      env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
    })
  );
});

it.each(['SIGINT', 'SIGTERM'] as const)(
  'forwards %s, waits for the child, and removes signal listeners',
  async (signal) => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    });
    mocks.spawn.mockReturnValue(child);
    const before = process.listenerCount(signal);
    const pending = runClaudeCommand(['login']);
    expect(process.listenerCount(signal)).toBe(before + 1);
    const forward = process.listeners(signal).at(-1);
    forward?.(signal);
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith(signal);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('exit', null, signal);
    await expect(pending).resolves.toBe(signal === 'SIGINT' ? 130 : 143);
    expect(process.listenerCount(signal)).toBe(before);
  }
);

it('reports a concise CLI failure instead of rejecting the command action', async () => {
  const program = new Command().exitOverride();
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const originalExitCode = process.exitCode;
  try {
    registerClaudeCommand(program, vi.fn().mockRejectedValue(new Error('missing runtime')));
    await expect(program.parseAsync(['node', 'ff', 'claude', 'login'])).resolves.toBe(program);
    expect(error).toHaveBeenCalledWith('Bundled Claude runtime is unavailable: missing runtime');
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = originalExitCode;
    error.mockRestore();
  }
});

it('rejects a failed spawn and removes signal listeners', async () => {
  const child = new EventEmitter();
  mocks.spawn.mockReturnValue(child);
  const before = process.listenerCount('SIGTERM');
  const pending = runClaudeCommand(['auth', 'login']);
  child.emit('error', new Error('spawn failed'));
  await expect(pending).rejects.toThrow('spawn failed');
  expect(process.listenerCount('SIGTERM')).toBe(before);
});
