import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockPersistWorkspaceCommands = vi.hoisted(() => vi.fn());
const mockFindWorkspacesByProjectId = vi.hoisted(() => vi.fn());
const mockUpdateWorkspace = vi.hoisted(() => vi.fn());
const mockFindProjectById = vi.hoisted(() => vi.fn());

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@/backend/services/workspace', () => ({
  projectManagementService: { findById: mockFindProjectById },
  workspaceDataService: {
    findByProjectId: mockFindWorkspacesByProjectId,
  },
  workspaceRunScriptService: { setCommands: mockUpdateWorkspace },
}));

import { runScriptConfigPersistenceService } from './run-script-config-persistence.service';

describe('runScriptConfigPersistenceService', () => {
  let workspaceDir: string;
  let repoDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPersistWorkspaceCommands.mockResolvedValue(undefined);
    mockUpdateWorkspace.mockResolvedValue(undefined);
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

  it('refreshes workspace commands and reports per-workspace config errors', async () => {
    mockFindWorkspacesByProjectId.mockResolvedValue([
      { id: 'w1', worktreePath: workspaceDir },
      { id: 'w2', worktreePath: repoDir },
      { id: 'w3', worktreePath: null },
    ]);
    writeFileSync(
      join(workspaceDir, 'factory-factory.json'),
      JSON.stringify({ scripts: { run: 'pnpm dev' } }),
      'utf8'
    );
    writeFileSync(join(repoDir, 'factory-factory.json'), '{invalid', 'utf8');

    const result = await runScriptConfigPersistenceService.refreshFactoryConfigs('p1');

    expect(result).toEqual({
      updatedCount: 1,
      totalWorkspaces: 3,
      errors: [{ workspaceId: 'w2', error: expect.stringContaining('Invalid JSON') }],
    });
    expect(mockUpdateWorkspace).toHaveBeenCalledWith('w1', {
      runScriptCommand: 'pnpm dev',
      runScriptPostRunCommand: null,
      runScriptCleanupCommand: null,
    });
  });

  it('reads project factory config and returns null when the file is missing', async () => {
    mockFindProjectById.mockResolvedValueOnce(null);
    await expect(runScriptConfigPersistenceService.getFactoryConfig('missing')).rejects.toThrow(
      'Project not found'
    );

    mockFindProjectById.mockResolvedValueOnce({ id: 'p1', repoPath: repoDir });
    writeFileSync(
      join(repoDir, 'factory-factory.json'),
      JSON.stringify({ scripts: { run: 'pnpm dev' } }),
      'utf8'
    );
    await expect(runScriptConfigPersistenceService.getFactoryConfig('p1')).resolves.toEqual({
      scripts: { run: 'pnpm dev' },
    });

    mockFindProjectById.mockResolvedValueOnce({ id: 'p1', repoPath: join(repoDir, 'missing') });
    await expect(runScriptConfigPersistenceService.getFactoryConfig('p1')).resolves.toBeNull();
  });

  it('logs malformed project factory config errors as a missing config', async () => {
    mockFindProjectById.mockResolvedValue({ id: 'p1', repoPath: repoDir });
    writeFileSync(join(repoDir, 'factory-factory.json'), '{invalid', 'utf8');

    await expect(runScriptConfigPersistenceService.getFactoryConfig('p1')).resolves.toBeNull();
  });
});
