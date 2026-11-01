import { EventEmitter } from 'node:events';
import { access, writeFile } from 'node:fs/promises';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { generateWorkspaceMetadata } from './workspace-metadata-generator';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  query: vi.fn(),
  context: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocks.query }));
vi.mock('@/backend/lib/owned-codex-command', () => ({
  getOwnedCodexCommand: (args: string[]) => ({ command: 'codex', args }),
}));
vi.mock('@/backend/lib/owned-process-cleanup', () => ({
  terminateDisposableProcessTree: mocks.cleanup,
}));
vi.mock('@/backend/services/codex-accounts', () => ({
  getMetadataCredentialsStore: () => Promise.resolve('keyring'),
  codexAccountService: { getRuntimeContext: mocks.context },
}));
vi.mock('@/backend/services/config.service', () => ({
  configService: {
    getWorkspaceMetadataConfig: () => ({
      enabled: true,
      codexModel: 'gpt-6-luna',
      claudeModel: 'haiku',
    }),
    getChildProcessEnv: () => ({ CLAUDE_CONFIG_DIR: '/managed/claude' }),
    getNodeExecPath: () => '/electron/node',
  },
}));
const result = {
  title: 'Login race',
  branch: 'login-race',
  summary: 'Testing a login fix.',
  sidebarSummary: 'Testing login',
};
afterEach(() => {
  vi.resetAllMocks();
});

describe('disposable metadata inference', () => {
  it('uses the selected Codex account, short instructions, schema, and disposable directory', async () => {
    mocks.context.mockResolvedValue({ env: { CODEX_HOME: '/managed/account' } });
    let received = '';
    let directory = '';
    mocks.spawn.mockImplementation((_command: string, args: string[], options: { cwd: string }) => {
      directory = options.cwd;
      const child = Object.assign(new EventEmitter(), {
        stdin: new Writable({
          write(chunk, _encoding, done) {
            received += String(chunk);
            done();
          },
        }),
        stderr: new PassThrough(),
      });
      child.stdin.on('finish', () => {
        void writeFile(
          args[args.indexOf('--output-last-message') + 1]!,
          JSON.stringify(result)
        ).then(() => child.emit('close', 0));
      });
      return child;
    });
    expect(
      await generateWorkspaceMetadata(
        { provider: 'CODEX', codexAccountId: 'chosen', input: { objective: 'Fix login' } },
        new AbortController().signal
      )
    ).toEqual(result);
    expect(mocks.context).toHaveBeenCalledWith('chosen');
    expect(JSON.parse(received)).toEqual({ objective: 'Fix login' });
    const [, args, options] = mocks.spawn.mock.calls[0]!;
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('features.shell_tool=false');
    expect(args).toContain('cli_auth_credentials_store="keyring"');
    expect(args.some((arg: string) => arg.startsWith('model_instructions_file='))).toBe(true);
    expect(options.env.CODEX_HOME).toBe('/managed/account');
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
    await expect(access(directory)).rejects.toThrow();
  });

  it('uses Haiku with a custom system prompt, no tools, and no saved session', async () => {
    const close = vi.fn();
    mocks.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield { type: 'result', subtype: 'success', structured_output: result };
      },
      close,
    });
    expect(
      await generateWorkspaceMetadata(
        { provider: 'CLAUDE', input: { objective: 'Fix login' } },
        new AbortController().signal
      )
    ).toEqual(result);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          model: 'haiku',
          tools: [],
          persistSession: false,
          settingSources: [],
          strictMcpConfig: true,
          systemPrompt: expect.stringContaining('what is happening in the work now'),
          settings: { disableAllHooks: true },
        }),
      })
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(mocks.context).not.toHaveBeenCalled();
    const invocation = mocks.query.mock.calls[0]![0];
    const signal = new AbortController().signal;
    invocation.options.spawnClaudeCodeProcess({
      command: 'node',
      args: ['/app.asar/claude.js'],
      cwd: '/disposable',
      env: invocation.options.env,
      signal,
    });
    expect(mocks.spawn).toHaveBeenCalledWith('/electron/node', ['/app.asar.unpacked/claude.js'], {
      cwd: '/disposable',
      env: expect.objectContaining({
        ELECTRON_RUN_AS_NODE: '1',
        CLAUDE_CONFIG_DIR: '/managed/claude',
      }),
      signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  it('rejects malformed provider output instead of publishing it', async () => {
    const close = vi.fn();
    mocks.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield {
          type: 'result',
          subtype: 'success',
          structured_output: { ...result, branch: '../main' },
        };
      },
      close,
    });
    const generation = generateWorkspaceMetadata(
      { provider: 'CLAUDE', input: {} },
      new AbortController().signal
    );
    await expect(generation).rejects.toBeInstanceOf(ZodError);
    await expect(generation).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ path: ['branch'] })]),
    });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
