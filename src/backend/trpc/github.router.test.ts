import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGithubCLIService = vi.hoisted(() => ({
  checkHealth: vi.fn(),
  getAuthenticatedUsername: vi.fn(),
  listIssues: vi.fn(),
  getIssue: vi.fn(),
}));

const mockWorkspaceDataService = vi.hoisted(() => ({
  findByIdWithProject: vi.fn(),
}));

const mockProjectManagementService = vi.hoisted(() => ({
  findById: vi.fn(),
}));

vi.mock('@/backend/domains/github', () => ({
  githubCLIService: mockGithubCLIService,
}));

vi.mock('@/backend/domains/workspace', () => ({
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
});
