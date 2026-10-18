import { EventEmitter } from 'node:events';
import { Command } from 'commander';
import { expect, it, vi } from 'vitest';
import { getBundledCodexCommand } from '@/backend/lib/codex-cli-command';
import { registerCodexCommand, runCodexCommand } from './codex';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

it('requests the native Codex version instead of the ACP wrapper version', () => {
  expect(getBundledCodexCommand(['--version']).args.slice(-2)).toEqual(['cli', '-V']);
});

it.each([['--version'], ['--help'], ['login', '--device-auth']])(
  'passes native CLI arguments through Commander: %s',
  async (...args) => {
    const program = new Command().version('app-version').exitOverride();
    const run = vi.fn().mockResolvedValue(0);
    registerCodexCommand(program, run);
    await program.parseAsync(['node', 'ff', 'codex', ...args]);
    expect(run).toHaveBeenCalledWith(args);
  }
);

it('forwards login arguments to the managed runtime and preserves its exit status', async () => {
  const child = new EventEmitter();
  mocks.spawn.mockImplementation(() => {
    queueMicrotask(() => child.emit('exit', 7));
    return child;
  });
  await expect(runCodexCommand(['login', '--device-auth'])).resolves.toBe(7);
  expect(mocks.spawn).toHaveBeenCalledWith(
    process.execPath,
    [expect.stringContaining('codex-acp'), 'cli', 'login', '--device-auth'],
    expect.objectContaining({
      stdio: 'inherit',
      env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
    })
  );
});

it.each(['SIGINT', 'SIGTERM'] as const)(
  'forwards %s, waits for the child, and removes signal listeners',
  async (signal) => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    mocks.spawn.mockReturnValue(child);
    const before = process.listenerCount(signal);
    const pending = runCodexCommand(['login']);
    expect(process.listenerCount(signal)).toBe(before + 1);
    const forward = process.listeners(signal).at(-1);
    forward?.(signal);
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
    registerCodexCommand(program, vi.fn().mockRejectedValue(new Error('missing runtime')));
    await expect(program.parseAsync(['node', 'ff', 'codex', 'login'])).resolves.toBe(program);
    expect(error).toHaveBeenCalledWith('Bundled Codex runtime is unavailable: missing runtime');
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = originalExitCode;
    error.mockRestore();
  }
});
