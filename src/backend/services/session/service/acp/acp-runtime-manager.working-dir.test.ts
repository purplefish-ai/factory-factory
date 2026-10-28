import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createManagerTestHarness, mockSpawn } from './acp-runtime-manager.test-harness';
import {
  defaultContext,
  defaultHandlers,
  defaultOptions,
} from './acp-runtime-manager.test-helpers';

let fixtureDir: string;

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'acp-working-dir-'));
});

afterEach(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

it.each(['CLAUDE', 'CODEX'] as const)(
  'rejects a deleted %s worktree before spawning and identifies the missing path',
  async (provider) => {
    const { manager, setupSuccessfulSpawn } = createManagerTestHarness();
    setupSuccessfulSpawn();
    const workingDir = join(fixtureDir, 'deleted-worktree');
    mkdirSync(workingDir);
    rmSync(workingDir, { recursive: true });
    const handlers = defaultHandlers();

    await expect(
      manager.getOrCreateClient(
        'missing-worktree',
        { ...defaultOptions(), provider, workingDir },
        handlers,
        { ...defaultContext(), workingDir }
      )
    ).rejects.toThrow(`ACP working directory does not exist: "${workingDir}"`);

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(handlers.onRuntimeError).not.toHaveBeenCalled();
    expect(manager.getClient('missing-worktree')).toBeUndefined();

    mkdirSync(workingDir);
    const handle = await manager.getOrCreateClient(
      'missing-worktree',
      { ...defaultOptions(), provider, workingDir },
      handlers,
      { ...defaultContext(), workingDir }
    );
    expect(handle.providerSessionId).toBe('provider-session-123');
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ cwd: workingDir })
    );
  }
);

it('rejects a file used as the working directory before spawning', async () => {
  const { manager, setupSuccessfulSpawn } = createManagerTestHarness();
  setupSuccessfulSpawn();
  const workingDir = join(fixtureDir, 'file');
  writeFileSync(workingDir, 'not a directory');

  await expect(
    manager.getOrCreateClient(
      'invalid-worktree',
      { ...defaultOptions(), workingDir },
      defaultHandlers(),
      { ...defaultContext(), workingDir }
    )
  ).rejects.toThrow(`ACP working directory is not a directory: "${workingDir}"`);

  expect(mockSpawn).not.toHaveBeenCalled();
});
