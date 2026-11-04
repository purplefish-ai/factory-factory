import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmFix, ensureNode, ensureServeTools, supportsNode } from './serve-prerequisites.mjs';

function setup({ answers = ['no'], available = ['git', 'gh'], platform = 'darwin' } = {}) {
  const commands: string[][] = [];
  const messages: string[] = [];
  const tools = new Set(available);
  const io = {
    platform,
    interactive: true,
    print: (message: string) => messages.push(message),
    ask: vi.fn(async () => answers.shift() ?? ''),
    probe: vi.fn(
      async (command: string, args: string[]) =>
        tools.has(command) && !(command === 'gh' && args[0] === 'auth')
    ),
    run: vi.fn((command: string, args: string[]) => {
      commands.push([command, ...args]);
      if (command === 'brew') {
        tools.add(args[1]!);
      }
      return Promise.resolve(true);
    }),
  };
  return { io, commands, messages, tools };
}
afterEach(() => vi.restoreAllMocks());

describe('Node requirement', () => {
  it.each(['26.12.1', '26.13.0', '27.0.0'])('accepts %s', (version) => {
    expect(supportsNode(version, '26.12.1')).toBe(true);
  });
  it.each(['26.12.0', '26.11.9', '25.99.9', '26.12.1-rc.1', 'garbage'])('rejects %s', (version) => {
    expect(supportsNode(version, '26.12.1')).toBe(false);
  });
  it('does not ask or probe when Node is supported', async () => {
    const { io } = setup();
    expect(await ensureNode('26.12.1', '26.12.1', io)).toBe(true);
    expect(io.ask).not.toHaveBeenCalled();
    expect(io.probe).not.toHaveBeenCalled();
  });
  it('offers an installed fnm and requires a restart after installation', async () => {
    const { io, commands, messages } = setup({ available: ['fnm'], answers: ['y'] });
    expect(await ensureNode('22.0.0', '26.12.1', io)).toBe(false);
    expect(commands).toEqual([['fnm', 'install', '26.12.1']]);
    expect(messages.join('\n')).toContain('fnm use 26.12.1');
  });
});

describe('consent', () => {
  it.each(['', 'n', 'no', 'sure'])('does not execute for %j', async (answer) => {
    const { io, commands } = setup({ answers: [answer] });
    expect(await confirmFix(['brew', 'install', 'git'], io)).toBe(false);
    expect(commands).toEqual([]);
  });
  it.each(['y', 'YES', ' yes '])('executes for explicit %j', async (answer) => {
    const { io, commands } = setup({ answers: [answer] });
    expect(await confirmFix(['brew', 'install', 'git'], io)).toBe(true);
    expect(commands).toEqual([['brew', 'install', 'git']]);
  });
  it('does not ask without a terminal', async () => {
    const { io, commands } = setup({ answers: ['y'] });
    io.interactive = false;
    expect(await confirmFix(['gh', 'auth', 'login'], io)).toBe(false);
    expect(io.ask).not.toHaveBeenCalled();
    expect(commands).toEqual([]);
  });
  it('treats EOF or cancellation as No', async () => {
    const { io, commands } = setup();
    io.ask.mockRejectedValue(new Error('closed'));
    expect(await confirmFix(['gh', 'auth', 'login'], io)).toBe(false);
    expect(commands).toEqual([]);
  });
  it('reports a failed fix', async () => {
    const { io, messages } = setup({ answers: ['y'] });
    io.run.mockResolvedValue(false);
    expect(await confirmFix(['brew', 'install', 'git'], io)).toBe(false);
    expect(messages.join('\n')).toContain('failed');
  });
});

describe('serve tools', () => {
  it('blocks missing Git when installation is declined', async () => {
    const { io, commands } = setup({ available: ['brew'] });
    expect(await ensureServeTools(io)).toBe(false);
    expect(commands).toEqual([]);
  });
  it('rechecks installed Git and asks separately for GitHub', async () => {
    const { io, commands } = setup({ available: ['brew'], answers: ['y', ''] });
    expect(await ensureServeTools(io)).toBe(true);
    expect(commands).toEqual([['brew', 'install', 'git']]);
    expect(io.ask).toHaveBeenCalledTimes(2);
  });
  it('blocks when an accepted installation does not make Git available', async () => {
    const { io } = setup({ available: ['brew'], answers: ['y'] });
    io.run.mockResolvedValue(true);
    expect(await ensureServeTools(io)).toBe(false);
  });
  it('allows local work when GitHub authentication is declined', async () => {
    const { io, commands } = setup();
    expect(await ensureServeTools(io)).toBe(true);
    expect(commands).toEqual([]);
  });
  it('uses exact WinGet package IDs on Windows', async () => {
    const { io, commands } = setup({ platform: 'win32', available: ['winget'], answers: ['y'] });
    expect(await ensureServeTools(io)).toBe(false);
    expect(commands).toEqual([['winget', 'install', '--exact', '--id', 'Git.Git']]);
  });
  it('provides manual guidance without a supported manager', async () => {
    const { io, messages } = setup({ available: [] });
    expect(await ensureServeTools(io)).toBe(false);
    expect(io.ask).not.toHaveBeenCalled();
    expect(messages.join('\n')).toContain('https://git-scm.com/downloads');
  });
});
