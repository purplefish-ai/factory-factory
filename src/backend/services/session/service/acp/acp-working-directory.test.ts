import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AcpClientFactory } from './acp-client-factory';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    throw new Error('Adapter spawn must not run for an invalid directory');
  }),
}));
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  getCurrentProcessEnv: () => ({}),
}));

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each(['deleted worktree', 'file', 'broken symlink'])(
  'rejects a %s with its actual path before spawning an adapter',
  async (kind) => {
    const directory = mkdtempSync(join(tmpdir(), 'ff-acp-directory-'));
    directories.push(directory);
    const workingDir = join(directory, 'worktree');
    if (kind === 'file') {
      writeFileSync(workingDir, 'not a directory');
    } else if (kind === 'broken symlink') {
      symlinkSync(join(directory, 'removed'), workingDir);
    } else {
      rmSync(directory, { recursive: true });
    }
    const signal = {
      promise: new Promise<never>(() => {
        // No stop or shutdown while testing preflight rejection.
      }),
      dispose: vi.fn(),
    };
    const creation = new AcpClientFactory().createClient({
      sessionId: 'missing-worktree',
      options: { provider: 'CODEX', sessionId: 'missing-worktree', workingDir },
      handlers: {},
      metadata: { incarnationId: 'test', purpose: 'active', installed: false },
      shutdownSignal: signal,
      stopSignal: signal,
      shouldDispatchRuntimeError: () => false,
    });
    await expect(creation).rejects.toThrow(`ACP working directory`);
    await expect(creation).rejects.toThrow(workingDir);
    expect(spawn).not.toHaveBeenCalled();
  }
);
