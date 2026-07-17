import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CorsConfig } from '@/backend/services/config.service';
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
const mockSearchFilesRecursive = vi.hoisted(() => vi.fn());
const mockParseGithubUrl = vi.hoisted(() => vi.fn());
const mockCheckGithubAuth = vi.hoisted(() => vi.fn());
const mockGetClonePath = vi.hoisted(() => vi.fn());
const mockCheckExistingClone = vi.hoisted(() => vi.fn());
const mockCloneRepo = vi.hoisted(() => vi.fn());

vi.mock('@/backend/lib/shell', () => ({
  gitCommandC: (...args: unknown[]) => mockGitCommandC(...args),
}));

vi.mock('@/backend/lib/file-helpers', () => ({
  searchFilesRecursive: (...args: unknown[]) => mockSearchFilesRecursive(...args),
}));

vi.mock('@/backend/services/git-clone.service', () => ({
  parseGithubUrl: (...args: unknown[]) => mockParseGithubUrl(...args),
}));

import { projectRouter } from './project.trpc';

function mkfifo(path: string): void {
  const result = spawnSync('mkfifo', [path], { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.error?.message || 'Failed to create FIFO');
  }
}

function createCaller(
  requestTrust?: {
    remoteAddress?: string;
    origin?: string;
    isLocal: boolean;
  },
  corsConfig: CorsConfig = {
    allowedOrigins: ['http://localhost:3000', 'http://localhost:3001'],
  }
) {
  return projectRouter.createCaller({
    requestTrust,
    appContext: {
      services: {
        configService: {
          getWorktreeBaseDir: () => '/tmp/worktrees',
          getReposDir: () => '/repos',
          getCorsConfig: () => corsConfig,
        },
        cryptoService: {
          encrypt: (value: string) => mockEncrypt(value),
        },
        factoryConfigService: {
          readConfig: (...args: unknown[]) => mockReadConfig(...args),
        },
        gitCloneService: {
          checkGithubAuth: (...args: unknown[]) => mockCheckGithubAuth(...args),
          getClonePath: (...args: unknown[]) => mockGetClonePath(...args),
          checkExistingClone: (...args: unknown[]) => mockCheckExistingClone(...args),
          clone: (...args: unknown[]) => mockCloneRepo(...args),
        },
        projectManagementService: mockProjectManagementService,
      },
    },
  } as never);
}

describe('projectRouter', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'project-router-test-'));
    vi.clearAllMocks();
    mockParseGithubUrl.mockReturnValue({
      owner: 'purplefish-ai',
      repo: 'factory-factory',
    });
    mockCheckGithubAuth.mockResolvedValue({
      authenticated: true,
      user: 'martin',
    });
    mockGetClonePath.mockReturnValue('/repos/purplefish-ai/factory-factory');
    mockCheckExistingClone.mockResolvedValue('valid_repo');
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

  it('throws when getById/getBySlug/listBranches cannot find project', async () => {
    mockProjectManagementService.findById.mockResolvedValue(null);
    mockProjectManagementService.findBySlug.mockResolvedValue(null);

    const caller = createCaller();
    await expect(caller.getById({ id: 'missing' })).rejects.toThrow('Project not found: missing');
    await expect(caller.getBySlug({ slug: 'missing' })).rejects.toThrow(
      'Project not found: missing'
    );
    await expect(caller.listBranches({ projectId: 'missing' })).rejects.toThrow(
      'Project not found: missing'
    );
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

  it('skips non-regular slash command files', async () => {
    const commandsPath = join(tempDir, '.claude', 'commands');
    const fifoTarget = join(tempDir, 'command-target');
    mkdirSync(commandsPath, { recursive: true });
    writeFileSync(
      join(commandsPath, 'issue-1809-valid.md'),
      '---\ndescription: Safe command\n---\n'
    );
    mkfifo(join(commandsPath, 'issue-1809-pipe.md'));
    mkfifo(fifoTarget);
    symlinkSync(fifoTarget, join(commandsPath, 'issue-1809-linked.md'));
    mockProjectManagementService.findById.mockResolvedValue({
      id: 'p1',
      repoPath: tempDir,
    });

    const caller = createCaller();
    const result = await caller.listSlashCommands({ projectId: 'p1' });
    const commandNames = result.commands.map((command) => command.name);

    expect(result.commands).toContainEqual({
      name: 'issue-1809-valid',
      description: 'Safe command',
    });
    expect(commandNames).not.toContain('issue-1809-pipe');
    expect(commandNames).not.toContain('issue-1809-linked');
  });

  it('handles malformed git ref lines and git branch listing failures', async () => {
    mockProjectManagementService.findById.mockResolvedValue({
      id: 'p1',
      repoPath: '/repo/path',
    });
    mockGitCommandC
      .mockResolvedValueOnce({
        code: 0,
        stdout: 'main aaaaa\nmalformed-ref-line\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: 'origin/HEAD ccccc\norigin/main bbbbb\n',
        stderr: '',
      });

    const caller = createCaller();
    const result = await caller.listBranches({ projectId: 'p1' });
    expect(result.branches).toEqual([
      { name: 'main', displayName: 'main', refType: 'local' },
      { name: 'origin/main', displayName: 'origin/main', refType: 'remote' },
    ]);

    mockGitCommandC.mockResolvedValueOnce({
      code: 1,
      stdout: '',
      stderr: 'failed',
    });
    await expect(caller.listBranches({ projectId: 'p1' })).rejects.toThrow(
      'Failed to list branches: failed'
    );
  });

  it('delegates file autocomplete to bounded search and validates project exists', async () => {
    const caller = createCaller();
    mockProjectManagementService.findById.mockResolvedValueOnce({
      id: 'p1',
      repoPath: '/repo/path',
    });
    mockSearchFilesRecursive.mockResolvedValueOnce(['src/alpha.ts', 'src/zeta.ts']);

    await expect(
      caller.listAllFiles({
        projectId: 'p1',
        query: 'SRC',
        limit: 2,
      })
    ).resolves.toEqual({
      files: ['src/alpha.ts', 'src/zeta.ts'],
    });

    expect(mockSearchFilesRecursive).toHaveBeenCalledWith('/repo/path', {
      query: 'SRC',
      limit: 2,
    });

    mockProjectManagementService.findById.mockResolvedValueOnce(null);
    await expect(caller.listAllFiles({ projectId: 'missing' })).rejects.toThrow(
      'Project not found: missing'
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
    mockProjectManagementService.update.mockResolvedValue({
      id: 'p1',
      issueTrackerConfig: {
        linear: {
          apiKey: 'enc:lin-api-key',
          teamId: 'team-1',
          teamName: 'Platform',
          viewerName: 'Martina',
        },
      },
    });

    const updatedProject = await caller.update({
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

    expect(updatedProject).toEqual({
      id: 'p1',
      issueTrackerConfig: {
        linear: {
          teamId: 'team-1',
          teamName: 'Platform',
          viewerName: 'Martina',
          hasApiKey: true,
        },
      },
    });
    expect(updatedProject.issueTrackerConfig?.linear).not.toHaveProperty('apiKey');

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

  it('rejects privileged project mutations from untrusted requests', async () => {
    const caller = createCaller({
      remoteAddress: '203.0.113.10',
      origin: 'https://attacker.example',
      isLocal: false,
    });

    await expect(caller.create({ repoPath: '/repo/path' })).rejects.toThrow(
      'trusted local Factory Factory client'
    );
    await expect(caller.update({ id: 'p1', name: 'Renamed' })).rejects.toThrow(
      'trusted local Factory Factory client'
    );
    await expect(
      caller.createFromGithub({ githubUrl: 'https://github.com/purplefish-ai/factory-factory' })
    ).rejects.toThrow('trusted local Factory Factory client');
    await expect(
      caller.saveFactoryConfig({
        projectId: 'p1',
        config: { scripts: { run: 'pnpm dev' } },
      })
    ).rejects.toThrow('trusted local Factory Factory client');

    expect(mockProjectManagementService.validateRepoPath).not.toHaveBeenCalled();
    expect(mockProjectManagementService.create).not.toHaveBeenCalled();
    expect(mockProjectManagementService.update).not.toHaveBeenCalled();
    expect(mockGetClonePath).not.toHaveBeenCalled();
    expect(mockCloneRepo).not.toHaveBeenCalled();
  });

  it('allows privileged project mutations from trusted local origins', async () => {
    const caller = createCaller({
      remoteAddress: '127.0.0.1',
      origin: 'http://localhost:3000',
      isLocal: true,
    });
    mockProjectManagementService.validateRepoPath.mockResolvedValue({ valid: true });
    mockProjectManagementService.create.mockResolvedValue({ id: 'created' });

    await expect(
      caller.create({
        repoPath: '/good/path',
        startupScriptPath: 'scripts/start.sh',
      })
    ).resolves.toEqual({ id: 'created' });
    expect(mockProjectManagementService.create).toHaveBeenCalledWith(
      {
        repoPath: '/good/path',
        startupScriptCommand: undefined,
        startupScriptPath: 'scripts/start.sh',
        startupScriptTimeout: undefined,
      },
      { worktreeBaseDir: '/tmp/worktrees' }
    );
  });

  it('allows privileged project mutations from equivalent loopback origins', async () => {
    const caller = createCaller({
      remoteAddress: '127.0.0.1',
      origin: 'http://127.0.0.1:3000',
      isLocal: true,
    });
    mockProjectManagementService.validateRepoPath.mockResolvedValue({ valid: true });
    mockProjectManagementService.create.mockResolvedValue({ id: 'created' });

    await expect(caller.create({ repoPath: '/good/path' })).resolves.toEqual({ id: 'created' });
    expect(mockProjectManagementService.create).toHaveBeenCalled();
  });

  it('allows privileged project mutations from configured trusted local CIDRs', async () => {
    const caller = createCaller(
      {
        remoteAddress: '172.17.0.1',
        origin: 'http://localhost:3000',
        isLocal: false,
      },
      {
        allowedOrigins: ['http://localhost:3000'],
        trustedLocalCidrs: ['172.17.0.1/32'],
      }
    );
    mockProjectManagementService.validateRepoPath.mockResolvedValue({ valid: true });
    mockProjectManagementService.create.mockResolvedValue({ id: 'created' });

    await expect(caller.create({ repoPath: '/good/path' })).resolves.toEqual({ id: 'created' });
    expect(mockProjectManagementService.create).toHaveBeenCalled();
  });

  it('rejects privileged project mutations from disallowed browser origins', async () => {
    const caller = createCaller({
      remoteAddress: '127.0.0.1',
      origin: 'https://attacker.example',
      isLocal: true,
    });

    await expect(caller.create({ repoPath: '/repo/path' })).rejects.toThrow(
      'trusted local Factory Factory client'
    );
    expect(mockProjectManagementService.validateRepoPath).not.toHaveBeenCalled();
  });

  it('creates projects successfully and validates update edge cases', async () => {
    const caller = createCaller();
    mockProjectManagementService.validateRepoPath.mockResolvedValue({ valid: true });
    mockProjectManagementService.create.mockResolvedValue({ id: 'created' });

    await expect(
      caller.create({
        repoPath: '/good/path',
        startupScriptCommand: 'pnpm dev',
        startupScriptTimeout: 120,
      })
    ).resolves.toEqual({ id: 'created' });
    expect(mockProjectManagementService.create).toHaveBeenCalledWith(
      {
        repoPath: '/good/path',
        startupScriptCommand: 'pnpm dev',
        startupScriptPath: undefined,
        startupScriptTimeout: 120,
      },
      {
        worktreeBaseDir: '/tmp/worktrees',
      }
    );

    mockProjectManagementService.validateRepoPath.mockResolvedValueOnce({
      valid: false,
      error: 'bad path',
    });
    await expect(caller.update({ id: 'p1', repoPath: '/bad/path' })).rejects.toThrow(
      'Invalid repository path: bad path'
    );

    mockProjectManagementService.validateRepoPath.mockResolvedValueOnce({ valid: true });
    mockProjectManagementService.findById.mockResolvedValueOnce(null);
    await expect(
      caller.update({ id: 'missing', startupScriptPath: 'scripts/start.sh' })
    ).rejects.toThrow('Project not found: missing');

    mockProjectManagementService.findById.mockResolvedValueOnce({
      id: 'p1',
      startupScriptCommand: 'pnpm dev',
      startupScriptPath: null,
    });
    await expect(
      caller.update({ id: 'p1', startupScriptPath: 'scripts/start.sh' })
    ).rejects.toThrow('Cannot have both startupScriptCommand and startupScriptPath set');
  });

  it('archives and validates repo paths via passthrough routes', async () => {
    const caller = createCaller();
    mockProjectManagementService.archive.mockResolvedValue({ ok: true });
    mockProjectManagementService.validateRepoPath.mockResolvedValue({
      valid: true,
      error: undefined,
    });

    await expect(caller.archive({ id: 'p1' })).resolves.toEqual({ ok: true });
    await expect(caller.validateRepoPath({ repoPath: '/repo/path' })).resolves.toEqual({
      valid: true,
      error: undefined,
    });
    expect(mockProjectManagementService.archive).toHaveBeenCalledWith('p1');
    expect(mockProjectManagementService.validateRepoPath).toHaveBeenCalledWith('/repo/path');
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

  it('returns exists=true for checkFactoryConfig and throws when save target is missing', async () => {
    const caller = createCaller();
    mockReadConfig.mockResolvedValueOnce({ scripts: { run: 'pnpm dev' } });
    await expect(caller.checkFactoryConfig({ repoPath: '/repo/path' })).resolves.toEqual({
      exists: true,
    });

    mockProjectManagementService.findById.mockResolvedValueOnce(null);
    await expect(
      caller.saveFactoryConfig({
        projectId: 'missing',
        config: {
          scripts: {
            run: 'pnpm test',
          },
        },
      })
    ).rejects.toThrow('Project not found');
  });

  it('checks GitHub auth and handles GitHub clone flow branches', async () => {
    const caller = createCaller();
    await expect(caller.checkGithubAuth()).resolves.toEqual({
      authenticated: true,
      user: 'martin',
    });

    await expect(
      caller.createFromGithub({
        githubUrl: 'https://github.com/purplefish-ai/factory-factory',
        startupScriptCommand: 'pnpm dev',
        startupScriptPath: './scripts/start.sh',
      })
    ).rejects.toThrow('Cannot specify both startupScriptCommand and startupScriptPath');

    mockParseGithubUrl
      .mockReturnValueOnce({ owner: 'purplefish-ai', repo: 'factory-factory' })
      .mockReturnValueOnce(null);
    await expect(
      caller.createFromGithub({
        githubUrl: 'https://github.com/purplefish-ai/factory-factory',
      })
    ).rejects.toThrow('Invalid GitHub URL');

    mockParseGithubUrl.mockReturnValue({ owner: 'purplefish-ai', repo: 'factory-factory' });
    mockCheckExistingClone.mockResolvedValueOnce('not_repo');
    await expect(
      caller.createFromGithub({
        githubUrl: 'https://github.com/purplefish-ai/factory-factory',
      })
    ).rejects.toThrow('Directory already exists');

    mockCheckExistingClone.mockResolvedValueOnce('not_exists');
    mockCloneRepo.mockResolvedValueOnce({ success: false, error: 'clone denied' });
    await expect(
      caller.createFromGithub({
        githubUrl: 'https://github.com/purplefish-ai/factory-factory',
      })
    ).rejects.toThrow('Failed to clone repository: clone denied');

    mockCheckExistingClone.mockResolvedValueOnce('not_exists');
    mockCloneRepo.mockResolvedValueOnce({ success: true });
    mockProjectManagementService.validateRepoPath.mockResolvedValueOnce({
      valid: false,
      error: 'missing .git',
    });
    await expect(
      caller.createFromGithub({
        githubUrl: 'https://github.com/purplefish-ai/factory-factory',
      })
    ).rejects.toThrow('Invalid repository after clone: missing .git');

    mockCheckExistingClone.mockResolvedValueOnce('valid_repo');
    mockProjectManagementService.validateRepoPath.mockResolvedValueOnce({ valid: true });
    mockProjectManagementService.create.mockResolvedValueOnce({ id: 'created-from-github' });
    await expect(
      caller.createFromGithub({
        githubUrl: 'https://github.com/purplefish-ai/factory-factory',
        startupScriptCommand: 'pnpm dev',
      })
    ).resolves.toEqual({ id: 'created-from-github' });

    expect(mockGetClonePath).toHaveBeenCalledWith('/repos', 'purplefish-ai', 'factory-factory');
    expect(mockProjectManagementService.create).toHaveBeenCalledWith(
      {
        repoPath: '/repos/purplefish-ai/factory-factory',
        startupScriptCommand: 'pnpm dev',
        startupScriptPath: undefined,
        startupScriptTimeout: undefined,
      },
      {
        worktreeBaseDir: '/tmp/worktrees',
      }
    );
  });
});
