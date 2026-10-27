import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toPublicProject } from '@/backend/orchestration/project-query-projection';
import {
  updateProjectSettings,
  type ProjectSettingsPorts,
} from '@/backend/orchestration/project-settings.orchestrator';
import type { Project } from '@prisma-gen/client';

const linear = {
  apiKey: 'encrypted-existing-key',
  teamId: 'team-1',
  teamName: 'Platform',
  viewerName: 'Alice',
};

const project: Project = {
  id: 'p1',
  name: 'Demo',
  slug: 'demo',
  repoPath: '/repo',
  worktreeBasePath: '/worktrees',
  defaultBranch: 'main',
  githubOwner: null,
  githubRepo: null,
  isArchived: false,
  startupScriptCommand: 'pnpm dev',
  startupScriptPath: null,
  startupScriptTimeout: 60,
  issueProvider: 'LINEAR',
  issueTrackerConfig: { linear },
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function createPorts() {
  return {
    validateRepoPath: vi
      .fn<ProjectSettingsPorts['validateRepoPath']>()
      .mockResolvedValue({ valid: true }),
    findById: vi.fn<ProjectSettingsPorts['findById']>().mockResolvedValue(project),
    update: vi.fn<ProjectSettingsPorts['update']>().mockResolvedValue(project),
    encrypt: vi
      .fn<ProjectSettingsPorts['encrypt']>()
      .mockImplementation((value) => `encrypted:${value}`),
  };
}

describe('updateProjectSettings', () => {
  let ports: ReturnType<typeof createPorts>;
  beforeEach(() => {
    ports = createPorts();
  });

  it('leaves omitted startup fields and the existing encrypted credential untouched', async () => {
    await expect(updateProjectSettings({ id: 'p1', name: 'Renamed' }, ports)).resolves.toEqual(
      project
    );
    expect(ports.update).toHaveBeenCalledWith('p1', { name: 'Renamed' });
    expect(ports.findById).not.toHaveBeenCalled();
    expect(ports.encrypt).not.toHaveBeenCalled();
    expect(project.issueTrackerConfig).toEqual({ linear });
  });

  it('preserves explicit null when clearing startup and issue tracker settings', async () => {
    await updateProjectSettings(
      { id: 'p1', startupScriptCommand: null, issueTrackerConfig: null },
      ports
    );
    expect(ports.update).toHaveBeenCalledWith('p1', {
      startupScriptCommand: null,
      issueTrackerConfig: null,
    });
    expect(ports.encrypt).not.toHaveBeenCalled();
  });

  it('rejects a path that conflicts with the retained command before encryption or persistence', async () => {
    await expect(
      updateProjectSettings(
        {
          id: 'p1',
          startupScriptPath: 'scripts/start.sh',
          issueTrackerConfig: { linear: { ...linear, apiKey: 'new-key' } },
        },
        ports
      )
    ).rejects.toThrow('Cannot have both startupScriptCommand and startupScriptPath set');
    expect(ports.encrypt).not.toHaveBeenCalled();
    expect(ports.update).not.toHaveBeenCalled();
  });

  it('rejects a command that conflicts with the retained path', async () => {
    ports.findById.mockResolvedValue({
      ...project,
      startupScriptCommand: null,
      startupScriptPath: 'scripts/start.sh',
    });
    await expect(
      updateProjectSettings({ id: 'p1', startupScriptCommand: 'pnpm dev' }, ports)
    ).rejects.toThrow('Cannot have both startupScriptCommand and startupScriptPath set');
    expect(ports.update).not.toHaveBeenCalled();
  });

  it('allows switching to a path by explicitly clearing the command', async () => {
    await updateProjectSettings(
      { id: 'p1', startupScriptCommand: null, startupScriptPath: 'scripts/start.sh' },
      ports
    );
    expect(ports.update).toHaveBeenCalledWith('p1', {
      startupScriptCommand: null,
      startupScriptPath: 'scripts/start.sh',
    });
  });

  it('rejects startup updates to a missing project', async () => {
    ports.findById.mockResolvedValue(null);
    await expect(
      updateProjectSettings({ id: 'missing', startupScriptCommand: null }, ports)
    ).rejects.toThrow('Project not found: missing');
    expect(ports.update).not.toHaveBeenCalled();
  });

  it('validates a changed repository before other side effects', async () => {
    ports.validateRepoPath.mockResolvedValue({ valid: false, error: 'not a git repo' });
    await expect(
      updateProjectSettings(
        { id: 'p1', repoPath: '/bad', startupScriptCommand: null, issueTrackerConfig: { linear } },
        ports
      )
    ).rejects.toThrow('Invalid repository path: not a git repo');
    expect(ports.validateRepoPath).toHaveBeenCalledWith('/bad');
    expect(ports.findById).not.toHaveBeenCalled();
    expect(ports.encrypt).not.toHaveBeenCalled();
    expect(ports.update).not.toHaveBeenCalled();
  });

  it('persists a valid repository update', async () => {
    await updateProjectSettings({ id: 'p1', repoPath: '/new-repo' }, ports);
    expect(ports.validateRepoPath).toHaveBeenCalledWith('/new-repo');
    expect(ports.update).toHaveBeenCalledWith('p1', { repoPath: '/new-repo' });
  });

  it('encrypts a new Linear key without mutating the caller input', async () => {
    const input = { id: 'p1', issueTrackerConfig: { linear: { ...linear, apiKey: 'new-key' } } };
    await updateProjectSettings(input, ports);
    expect(ports.encrypt).toHaveBeenCalledExactlyOnceWith('new-key');
    expect(ports.update).toHaveBeenCalledWith('p1', {
      issueTrackerConfig: { linear: { ...linear, apiKey: 'encrypted:new-key' } },
    });
    expect(input.issueTrackerConfig.linear.apiKey).toBe('new-key');
  });

  it('does not persist when encryption fails', async () => {
    ports.encrypt.mockImplementation(() => {
      throw new Error('Encryption unavailable');
    });
    await expect(
      updateProjectSettings({ id: 'p1', issueTrackerConfig: { linear } }, ports)
    ).rejects.toThrow('Encryption unavailable');
    expect(ports.update).not.toHaveBeenCalled();
  });

  it('persists configuration without Linear credentials without encrypting', async () => {
    await updateProjectSettings({ id: 'p1', issueTrackerConfig: {} }, ports);
    expect(ports.update).toHaveBeenCalledWith('p1', { issueTrackerConfig: {} });
    expect(ports.encrypt).not.toHaveBeenCalled();
  });
});

describe('toPublicProject', () => {
  it('redacts credentials while retaining public fields and leaving the raw record usable', () => {
    const withCount = { ...project, _count: { workspaces: 2 } };
    const result = toPublicProject(withCount);
    expect(result).toEqual({
      ...withCount,
      issueTrackerConfig: {
        linear: { teamId: 'team-1', teamName: 'Platform', viewerName: 'Alice', hasApiKey: true },
      },
    });
    expect(result.issueTrackerConfig?.linear).not.toHaveProperty('apiKey');
    expect(withCount.issueTrackerConfig).toEqual({ linear });
  });

  it.each([null, { linear: { apiKey: 'secret', teamId: 3 } }])(
    'fails closed for absent or malformed configuration: %j',
    (issueTrackerConfig) => {
      expect(toPublicProject({ issueTrackerConfig }).issueTrackerConfig).toBeNull();
    }
  );

  it('preserves an empty configuration', () => {
    expect(toPublicProject({ issueTrackerConfig: {} }).issueTrackerConfig).toEqual({});
  });
});
