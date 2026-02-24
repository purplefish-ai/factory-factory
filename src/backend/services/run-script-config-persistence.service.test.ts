import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockPersistWorkspaceCommands = vi.hoisted(() => vi.fn());

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { runScriptConfigPersistenceService } from './run-script-config-persistence.service';

describe('runScriptConfigPersistenceService', () => {
  let workspaceDir: string;
  let repoDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPersistWorkspaceCommands.mockResolvedValue(undefined);
    workspaceDir = mkdtempSync(join(tmpdir(), 'ff-rs-worktree-'));
    repoDir = mkdtempSync(join(tmpdir(), 'ff-rs-repo-'));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('writes UI config to disk and syncs workspace command cache', async () => {
    await runScriptConfigPersistenceService.writeFactoryConfigAndSyncWorkspace({
      workspaceId: 'w1',
      worktreePath: workspaceDir,
      projectRepoPath: repoDir,
      config: {
        scripts: {
          run: 'pnpm dev',
          postRun: 'cloudflared tunnel --url http://localhost:{port}',
          cleanup: 'pkill node',
        },
      },
      persistWorkspaceCommands: mockPersistWorkspaceCommands,
    });

    const workspaceConfig = readFileSync(join(workspaceDir, 'factory-factory.json'), 'utf8');
    const repoConfig = readFileSync(join(repoDir, 'factory-factory.json'), 'utf8');

    expect(workspaceConfig).toContain('"run": "pnpm dev"');
    expect(repoConfig).toContain('"cleanup": "pkill node"');
    expect(mockPersistWorkspaceCommands).toHaveBeenCalledWith('w1', {
      runScriptCommand: 'pnpm dev',
      runScriptPostRunCommand: 'cloudflared tunnel --url http://localhost:{port}',
      runScriptCleanupCommand: 'pkill node',
    });
  });

  it('syncs command cache after manual factory-factory.json edits', async () => {
    const configPath = join(workspaceDir, 'factory-factory.json');
    writeFileSync(configPath, JSON.stringify({ scripts: { run: 'pnpm dev' } }, null, 2), 'utf8');

    await runScriptConfigPersistenceService.syncWorkspaceCommandsFromWorktreeConfig({
      workspaceId: 'w1',
      worktreePath: workspaceDir,
      persistWorkspaceCommands: mockPersistWorkspaceCommands,
    });

    writeFileSync(
      configPath,
      JSON.stringify({ scripts: { run: 'pnpm preview', cleanup: 'pkill node' } }, null, 2),
      'utf8'
    );

    await runScriptConfigPersistenceService.syncWorkspaceCommandsFromWorktreeConfig({
      workspaceId: 'w1',
      worktreePath: workspaceDir,
      persistWorkspaceCommands: mockPersistWorkspaceCommands,
    });

    expect(mockPersistWorkspaceCommands).toHaveBeenNthCalledWith(1, 'w1', {
      runScriptCommand: 'pnpm dev',
      runScriptPostRunCommand: null,
      runScriptCleanupCommand: null,
    });
    expect(mockPersistWorkspaceCommands).toHaveBeenNthCalledWith(2, 'w1', {
      runScriptCommand: 'pnpm preview',
      runScriptPostRunCommand: null,
      runScriptCleanupCommand: 'pkill node',
    });
  });

  it('repairs drift when workspace cache does not match factory config', async () => {
    writeFileSync(
      join(workspaceDir, 'factory-factory.json'),
      JSON.stringify({ scripts: { run: 'pnpm dev', cleanup: 'pkill node' } }, null, 2),
      'utf8'
    );

    const commands = await runScriptConfigPersistenceService.reconcileWorkspaceCommandCache({
      workspace: {
        id: 'w1',
        worktreePath: workspaceDir,
        runScriptCommand: 'npm start',
        runScriptPostRunCommand: null,
        runScriptCleanupCommand: null,
      },
      persistWorkspaceCommands: mockPersistWorkspaceCommands,
    });

    expect(commands).toEqual({
      runScriptCommand: 'pnpm dev',
      runScriptPostRunCommand: null,
      runScriptCleanupCommand: 'pkill node',
    });
    expect(mockPersistWorkspaceCommands).toHaveBeenCalledWith('w1', commands);
  });

  it('does not write when workspace cache already matches config', async () => {
    writeFileSync(
      join(workspaceDir, 'factory-factory.json'),
      JSON.stringify({ scripts: { run: 'pnpm dev' } }, null, 2),
      'utf8'
    );

    await runScriptConfigPersistenceService.reconcileWorkspaceCommandCache({
      workspace: {
        id: 'w1',
        worktreePath: workspaceDir,
        runScriptCommand: 'pnpm dev',
        runScriptPostRunCommand: null,
        runScriptCleanupCommand: null,
      },
      persistWorkspaceCommands: mockPersistWorkspaceCommands,
    });

    expect(mockPersistWorkspaceCommands).not.toHaveBeenCalled();
  });
});
