import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGithubCLIService = vi.hoisted(() => ({
  checkHealth: vi.fn(),
  getAuthenticatedUsername: vi.fn(),
  listIssues: vi.fn(),
  getIssue: vi.fn(),
}));
const mockClassifyGitHubCLIError = vi.hoisted(() => vi.fn());

const mockWorkspaceDataService = vi.hoisted(() => ({
  findByIdWithProject: vi.fn(),
  findByProjectId: vi.fn(),
}));

const mockProjectManagementService = vi.hoisted(() => ({
  findById: vi.fn(),
}));

vi.mock('@/backend/services/github', () => ({
  githubCLIService: mockGithubCLIService,
  classifyGitHubCLIError: mockClassifyGitHubCLIError,
}));

vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: mockWorkspaceDataService,
  projectManagementService: mockProjectManagementService,
}));

import { githubRouter } from './github.trpc';

function createCaller() {
  return githubRouter.createCaller({ appContext: { services: {} } } as never);
}

describe('githubRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClassifyGitHubCLIError.mockReturnValue('unknown');
    mockWorkspaceDataService.findByProjectId.mockResolvedValue([]);
  });

  it('checks health and project/repo availability', async () => {
    mockGithubCLIService.checkHealth.mockResolvedValue({
      isInstalled: true,
      isAuthenticated: true,
    });
    mockWorkspaceDataService.findByIdWithProject.mockResolvedValue(null);

    const caller = createCaller();
    await expect(caller.checkHealth()).resolves.toEqual({
      isInstalled: true,
      isAuthenticated: true,
    });
    await expect(caller.hasGitHubRepo({ workspaceId: 'w1' })).resolves.toBe(false);
  });

  it('lists workspace issues with health and auth checks', async () => {
    const caller = createCaller();
    mockGithubCLIService.checkHealth.mockResolvedValue({
      isInstalled: true,
      isAuthenticated: true,
    });
    mockGithubCLIService.getAuthenticatedUsername.mockResolvedValue('martin');
    mockWorkspaceDataService.findByIdWithProject.mockResolvedValue({
      id: 'w1',
      project: {
        githubOwner: 'purplefish-ai',
        githubRepo: 'factory-factory',
      },
    });
    mockGithubCLIService.listIssues.mockResolvedValue([{ number: 101 }]);

    await expect(caller.listIssuesForWorkspace({ workspaceId: 'w1' })).resolves.toEqual({
      issues: [{ number: 101 }],
      health: { isInstalled: true, isAuthenticated: true },
      error: null,
      authenticatedUser: 'martin',
    });
  });

  it('lists project issues, and gets issue details with error handling', async () => {
    const caller = createCaller();
    mockGithubCLIService.checkHealth.mockResolvedValue({
      isInstalled: true,
      isAuthenticated: true,
    });
    mockProjectManagementService.findById.mockResolvedValue({
      id: 'p1',
      githubOwner: 'purplefish-ai',
      githubRepo: 'factory-factory',
    });
    mockGithubCLIService.listIssues.mockResolvedValue([{ number: 55, title: 'Fix bug' }]);
    mockGithubCLIService.getIssue.mockRejectedValueOnce(new Error('boom'));

    await expect(caller.listIssuesForProject({ projectId: 'p1' })).resolves.toEqual({
      issues: [{ number: 55, title: 'Fix bug' }],
      health: { isInstalled: true, isAuthenticated: true },
      error: null,
    });
    expect(mockGithubCLIService.listIssues).toHaveBeenCalledWith(
      'purplefish-ai',
      'factory-factory',
      { assignee: '@me' }
    );

    await expect(caller.getIssue({ projectId: 'p1', issueNumber: 99 })).resolves.toEqual({
      issue: null,
      error: 'boom',
    });
  });

  it('filters project issues that already have active workspaces', async () => {
    const caller = createCaller();
    mockGithubCLIService.checkHealth.mockResolvedValue({
      isInstalled: true,
      isAuthenticated: true,
    });
    mockProjectManagementService.findById.mockResolvedValue({
      id: 'p1',
      githubOwner: 'purplefish-ai',
      githubRepo: 'factory-factory',
    });
    mockGithubCLIService.listIssues.mockResolvedValue([
      { number: 55, title: 'Has workspace' },
      { number: 56, title: 'No workspace' },
      { number: 57, title: 'Archived workspace' },
    ]);
    mockWorkspaceDataService.findByProjectId.mockResolvedValue([
      { githubIssueNumber: 55, status: 'READY' },
      { githubIssueNumber: 57, status: 'ARCHIVED' },
    ]);

    await expect(caller.listIssuesForProject({ projectId: 'p1' })).resolves.toEqual({
      issues: [
        { number: 56, title: 'No workspace' },
        { number: 57, title: 'Archived workspace' },
      ],
      health: { isInstalled: true, isAuthenticated: true },
      error: null,
    });
  });

  it('returns unauthenticated health when issue listing hits bad gh credentials', async () => {
    const caller = createCaller();
    mockGithubCLIService.checkHealth.mockResolvedValue({
      isInstalled: true,
      isAuthenticated: true,
      version: '2.20.0',
    });
    mockProjectManagementService.findById.mockResolvedValue({
      id: 'p1',
      githubOwner: 'purplefish-ai',
      githubRepo: 'factory-factory',
    });
    mockGithubCLIService.listIssues.mockRejectedValueOnce(new Error('HTTP 401: Bad credentials'));
    mockClassifyGitHubCLIError.mockReturnValueOnce('auth_required');

    await expect(caller.listIssuesForProject({ projectId: 'p1' })).resolves.toEqual({
      issues: [],
      health: {
        isInstalled: true,
        isAuthenticated: false,
        version: '2.20.0',
        error:
          'GitHub CLI authentication failed. Run `gh auth refresh -h github.com` or `gh auth login` to authenticate.',
        errorType: 'auth_required',
      },
      error:
        'GitHub CLI authentication failed. Run `gh auth refresh -h github.com` or `gh auth login` to authenticate.',
    });
  });
});
