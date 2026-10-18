import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { resolveProviderAcpSpawnCommand } from './acp-runtime-spawn';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), load: vi.fn() }));
vi.mock('node:module', () => ({
  createRequire: () => Object.assign(mocks.load, { resolve: mocks.resolve }),
}));

beforeEach(() => {
  mocks.resolve.mockReset();
  mocks.load.mockReset();
});

it.each(['CLAUDE', 'CODEX'] as const)(
  'retains PATH execution when %s package resolution fails',
  (provider) => {
    mocks.resolve.mockImplementation(() => {
      throw new Error('package missing');
    });
    const binary = provider === 'CODEX' ? 'codex-acp' : 'claude-agent-acp';
    expect(resolveProviderAcpSpawnCommand(provider)).toEqual({
      command: binary,
      args: [],
      commandLabel: binary,
    });
  }
);

it('runs resolved package entrypoints with the bundled Node runtime', () => {
  mocks.resolve.mockReturnValue(join('/app', 'app.asar', 'node_modules', 'codex', 'package.json'));
  mocks.load.mockReturnValue({ bin: { 'codex-acp': 'dist/index.js' } });
  expect(resolveProviderAcpSpawnCommand('CODEX')).toEqual({
    command: process.execPath,
    args: [join('/app', 'app.asar.unpacked', 'node_modules', 'codex', 'dist/index.js')],
    commandLabel: expect.stringContaining('codex-acp'),
  });
});
