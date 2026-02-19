import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IssueProvider } from '@/shared/core/enums';

const mockProjectManagementService = vi.hoisted(() => ({
  list: vi.fn(),
  findById: vi.fn(),
  findBySlug: vi.fn(),
  validateRepoPath: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
}));

const mockGitCommandC = vi.hoisted(() => vi.fn());
const mockEncrypt = vi.hoisted(() => vi.fn((value: string) => `enc:${value}`));
const mockReadConfig = vi.hoisted(() => vi.fn());

vi.mock('@/backend/domains/workspace', () => ({
  projectManagementService: mockProjectManagementService,
}));

vi.mock('@/backend/lib/shell', () => ({
  gitCommandC: (...args: unknown[]) => mockGitCommandC(...args),
}));

vi.mock('@/backend/services/crypto.service', () => ({
  cryptoService: {
    encrypt: (value: string) => mockEncrypt(value),
  },
}));

vi.mock('@/backend/services/factory-config.service', () => ({
  FactoryConfigService: {
    readConfig: (...args: unknown[]) => mockReadConfig(...args),
  },
}));

import { projectRouter } from './project.trpc';

function createCaller() {
  return projectRouter.createCaller({
    appContext: {
      services: {
        configService: {
          getWorktreeBaseDir: () => '/tmp/worktrees',
        },
      },
    },
  } as never);
}

describe('projectRouter', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'project-router-test-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('lists projects and fetches by id/slug', async () => {
    const project = {
      id: 'p1',
      slug: 'demo',
      issueTrackerConfig: null,
    };

    mockProjectManagementService.list.mockResolvedValue([project]);
    mockProjectManagementService.findById.mockResolvedValue(project);
    mockProjectManagementService.findBySlug.mockResolvedValue(project);

    const caller = createCaller();

    await expect(caller.list({ limit: 10 })).resolves.toEqual([project]);
    await expect(caller.getById({ id: 'p1' })).resolves.toEqual(project);
    await expect(caller.getBySlug({ slug: 'demo' })).resolves.toEqual(project);
  });

  it('builds branch list from local and remote refs', async () => {
    mockProjectManagementService.findById.mockResolvedValue({
      id: 'p1',
      repoPath: '/repo/path',
    });
    mockGitCommandC
      .mockResolvedValueOnce({
        code: 0,
        stdout: 'main aaaaa\nfeature/one bbbbb\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout:
          'origin/HEAD ccccc\norigin/main aaaaa\norigin/feature/one bbbbb\norigin/new ddddd\n',
        stderr: '',
      });

    const caller = createCaller();
    const result = await caller.listBranches({ projectId: 'p1' });

    expect(result.branches).toEqual(
      expect.arrayContaining([
        { name: 'main', displayName: 'main', refType: 'local' },
        { name: 'feature/one', displayName: 'feature/one', refType: 'local' },
        { name: 'origin/new', displayName: 'new', refType: 'remote' },
      ])
    );
    expect(result.branches).not.toContainEqual(
      expect.objectContaining({ name: 'origin/main', refType: 'remote' })
    );
  });

  it('validates create/update rules and encrypts linear keys on update', async () => {
    const caller = createCaller();

    await expect(
      caller.create({
        repoPath: '/repo/path',
        startupScriptCommand: 'echo hi',
        startupScriptPath: 'scripts/start.sh',
      })
    ).rejects.toThrow('Cannot specify both startupScriptCommand and startupScriptPath');

    mockProjectManagementService.validateRepoPath.mockResolvedValue({
      valid: false,
      error: 'not a git repo',
    });
    await expect(caller.create({ repoPath: '/bad/path' })).rejects.toThrow(
      'Invalid repository path: not a git repo'
    );

    mockProjectManagementService.validateRepoPath.mockResolvedValue({ valid: true });
    mockProjectManagementService.findById.mockResolvedValue({
      id: 'p1',
      startupScriptCommand: null,
      startupScriptPath: null,
    });
    mockProjectManagementService.update.mockResolvedValue({ id: 'p1', ok: true });

    await caller.update({
      id: 'p1',
      issueProvider: IssueProvider.LINEAR,
      issueTrackerConfig: {
        linear: {
          apiKey: 'lin-api-key',
          teamId: 'team-1',
          teamName: 'Platform',
          viewerName: 'Martina',
        },
      },
    });

    expect(mockEncrypt).toHaveBeenCalledWith('lin-api-key');
    expect(mockProjectManagementService.update).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        issueTrackerConfig: {
          linear: expect.objectContaining({ apiKey: 'enc:lin-api-key' }),
        },
      })
    );
  });

  it('handles factory config checks and saveFactoryConfig writes the config file', async () => {
    const caller = createCaller();
    mockReadConfig.mockRejectedValueOnce(new Error('missing'));
    await expect(caller.checkFactoryConfig({ repoPath: '/repo/path' })).resolves.toEqual({
      exists: false,
    });

    mockProjectManagementService.findById.mockResolvedValue({ id: 'p1', repoPath: tempDir });
    await expect(
      caller.saveFactoryConfig({
        projectId: 'p1',
        config: {
          scripts: {
            run: 'pnpm test',
          },
        },
      })
    ).resolves.toEqual({ success: true });

    const written = readFileSync(join(tempDir, 'factory-factory.json'), 'utf-8');
    expect(written).toContain('"run": "pnpm test"');
  });
});
