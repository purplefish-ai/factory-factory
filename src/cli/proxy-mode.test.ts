import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { type ProxyCommandOptions, registerProxyCommand, resolveProxyMode } from './proxy-mode';

function createProgram() {
  const run = vi.fn<(options: ProxyCommandOptions) => Promise<void>>(async () => undefined);
  const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
  registerProxyCommand(program, run);
  for (const command of program.commands) {
    command.exitOverride().configureOutput({ writeErr: () => undefined });
  }
  return { program, run };
}

describe('ff proxy mode', () => {
  it.each([
    [[], 'private'],
    [['--private'], 'private'],
    [['--public'], 'public'],
  ] as const)('ff proxy %j runs in %s mode', async (args, mode) => {
    const { program, run } = createProgram();
    await program.parseAsync(['proxy', ...args], { from: 'user' });

    expect(run).toHaveBeenCalledTimes(1);
    const [options] = run.mock.calls[0] ?? [];
    expect(resolveProxyMode(options ?? {})).toBe(mode);
  });

  it('rejects --public together with --private', async () => {
    const { program, run } = createProgram();
    await expect(
      program.parseAsync(['proxy', '--public', '--private'], { from: 'user' })
    ).rejects.toMatchObject({ code: 'commander.conflictingOption' });
    expect(run).not.toHaveBeenCalled();
    expect(() => resolveProxyMode({ public: true, private: true })).toThrow(
      '--public and --private cannot be used together.'
    );
  });

  it('describes password protection as the default in help', () => {
    const { program } = createProgram();
    const help = program.commands.find((command) => command.name() === 'proxy')?.helpInformation();
    expect(help).toContain('password-protected by default');
    expect(help).toContain('--public');
    expect(help).toContain('read-only');
  });
});
