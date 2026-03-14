import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FactoryConfigSchema } from '@/shared/schemas/factory-config.schema';

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

  it('preserves quickActions when writing scripts-only updates', async () => {
    writeFileSync(
      join(workspaceDir, 'factory-factory.json'),
      JSON.stringify(
        {
          scripts: { run: 'pnpm old-dev' },
          quickActions: {
            includeDefaults: false,
            actions: [{ id: 'review', path: '.factory-factory/actions/review.md', pinned: true }],
          },
        },
        null,
        2
      ),
      'utf8'
    );

    await runScriptConfigPersistenceService.writeFactoryConfigAndSyncWorkspace({
      workspaceId: 'w1',
      worktreePath: workspaceDir,
      config: {
        scripts: {
          run: 'pnpm dev',
        },
      },
      persistWorkspaceCommands: mockPersistWorkspaceCommands,
    });

    const workspaceConfig = FactoryConfigSchema.parse(
      JSON.parse(readFileSync(join(workspaceDir, 'factory-factory.json'), 'utf8'))
    );
    expect(workspaceConfig.scripts.run).toBe('pnpm dev');
    expect(workspaceConfig.quickActions?.includeDefaults).toBe(false);
    expect(workspaceConfig.quickActions?.actions).toHaveLength(1);
    expect(workspaceConfig.quickActions?.actions?.[0]?.id).toBe('review');
  });

  it('preserves repo-only quickActions when syncing scripts back to the project repo', async () => {
    writeFileSync(
      join(workspaceDir, 'factory-factory.json'),
      JSON.stringify(
        {
          scripts: { run: 'pnpm old-dev' },
        },
        null,
        2
      ),
      'utf8'
    );
    writeFileSync(
      join(repoDir, 'factory-factory.json'),
      JSON.stringify(
        {
          scripts: { run: 'pnpm old-dev' },
          quickActions: {
            includeDefaults: false,
            actions: [{ id: 'review', path: '.factory-factory/actions/review.md', pinned: true }],
          },
        },
        null,
        2
      ),
      'utf8'
    );

    await runScriptConfigPersistenceService.writeFactoryConfigAndSyncWorkspace({
      workspaceId: 'w1',
      worktreePath: workspaceDir,
      projectRepoPath: repoDir,
      config: {
        scripts: {
          run: 'pnpm dev',
        },
      },
      persistWorkspaceCommands: mockPersistWorkspaceCommands,
    });

    const repoConfig = FactoryConfigSchema.parse(
      JSON.parse(readFileSync(join(repoDir, 'factory-factory.json'), 'utf8'))
    );
    expect(repoConfig.scripts.run).toBe('pnpm dev');
    expect(repoConfig.quickActions?.includeDefaults).toBe(false);
    expect(repoConfig.quickActions?.actions).toHaveLength(1);
    expect(repoConfig.quickActions?.actions?.[0]?.id).toBe('review');
  });

  it('propagates invalid worktree config errors instead of overwriting the file', async () => {
    writeFileSync(join(workspaceDir, 'factory-factory.json'), '{ invalid json', 'utf8');

    await expect(
      runScriptConfigPersistenceService.writeFactoryConfigAndSyncWorkspace({
        workspaceId: 'w1',
        worktreePath: workspaceDir,
        config: {
          scripts: {
            run: 'pnpm dev',
          },
        },
        persistWorkspaceCommands: mockPersistWorkspaceCommands,
      })
    ).rejects.toThrow(/Invalid JSON/);

    expect(readFileSync(join(workspaceDir, 'factory-factory.json'), 'utf8')).toBe('{ invalid json');
  });

  it('propagates invalid repo config errors instead of overwriting the file', async () => {
    writeFileSync(
      join(workspaceDir, 'factory-factory.json'),
      JSON.stringify({ scripts: { run: 'pnpm old-dev' } }, null, 2),
      'utf8'
    );
    writeFileSync(join(repoDir, 'factory-factory.json'), '{ invalid json', 'utf8');

    await expect(
      runScriptConfigPersistenceService.writeFactoryConfigAndSyncWorkspace({
        workspaceId: 'w1',
        worktreePath: workspaceDir,
        projectRepoPath: repoDir,
        config: {
          scripts: {
            run: 'pnpm dev',
          },
        },
        persistWorkspaceCommands: mockPersistWorkspaceCommands,
      })
    ).rejects.toThrow(/Invalid JSON/);

    expect(readFileSync(join(repoDir, 'factory-factory.json'), 'utf8')).toBe('{ invalid json');
    expect(
      FactoryConfigSchema.parse(
        JSON.parse(readFileSync(join(workspaceDir, 'factory-factory.json'), 'utf8'))
      )
    ).toEqual({
      scripts: {
        run: 'pnpm old-dev',
      },
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
