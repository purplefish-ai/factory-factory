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
