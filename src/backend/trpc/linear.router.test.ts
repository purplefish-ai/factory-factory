import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindProjectById = vi.hoisted(() => vi.fn());
const mockFindWorkspacesByProjectId = vi.hoisted(() => vi.fn());
const mockValidateKeyAndListTeams = vi.hoisted(() => vi.fn());
const mockListMyIssues = vi.hoisted(() => vi.fn());
const mockGetIssue = vi.hoisted(() => vi.fn());
const mockDecrypt = vi.hoisted(() => vi.fn());

import { linearRouter } from './linear.trpc';

function createCaller() {
  return linearRouter.createCaller({
    appContext: {
      services: {
        cryptoService: { decrypt: (...args: unknown[]) => mockDecrypt(...args) },
        linearClientService: {
          validateKeyAndListTeams: (...args: unknown[]) => mockValidateKeyAndListTeams(...args),
          listMyIssues: (...args: unknown[]) => mockListMyIssues(...args),
          getIssue: (...args: unknown[]) => mockGetIssue(...args),
        },
        projectManagementService: {
          findById: (...args: unknown[]) => mockFindProjectById(...args),
        },
        workspaceDataService: {
          findByProjectId: (...args: unknown[]) => mockFindWorkspacesByProjectId(...args),
        },
      },
    },
  } as never);
}

describe('linearRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindWorkspacesByProjectId.mockResolvedValue([]);
  });

  it('validates API key and lists teams', async () => {
    mockValidateKeyAndListTeams.mockResolvedValue([{ id: 'team-1', name: 'Core' }]);
    const caller = createCaller();

    await expect(caller.validateKeyAndListTeams({ apiKey: 'lin_api' })).resolves.toEqual([
      { id: 'team-1', name: 'Core' },
    ]);
  });

  it('returns project/config errors for listIssuesForProject', async () => {
    const caller = createCaller();

    mockFindProjectById.mockResolvedValueOnce(null);
    await expect(caller.listIssuesForProject({ projectId: 'p1' })).resolves.toEqual({
      issues: [],
      error: 'Project not found',
    });

    mockFindProjectById.mockResolvedValueOnce({ issueTrackerConfig: {} });
    await expect(caller.listIssuesForProject({ projectId: 'p1' })).resolves.toEqual({
      issues: [],
      error: 'Linear not configured for this project',
    });
  });

  it('lists issues and handles fetch errors', async () => {
    mockFindProjectById.mockResolvedValue({
      issueTrackerConfig: {
        linear: {
          apiKey: 'encrypted-key',
          teamId: 'team-1',
          teamName: 'Core',
          viewerName: 'Alice',
        },
      },
    });
    mockDecrypt.mockReturnValue('lin_api_decrypted');

    mockListMyIssues.mockResolvedValueOnce([{ id: 'FF-1' }]);

    const caller = createCaller();
    await expect(caller.listIssuesForProject({ projectId: 'p1' })).resolves.toEqual({
      issues: [{ id: 'FF-1' }],
      error: null,
    });

    mockListMyIssues.mockRejectedValueOnce(new Error('linear down'));
    await expect(caller.listIssuesForProject({ projectId: 'p1' })).resolves.toEqual({
      issues: [],
      error: 'linear down',
    });
  });

  it('filters issues that already have active workspaces', async () => {
    mockFindProjectById.mockResolvedValue({
      issueTrackerConfig: {
        linear: {
          apiKey: 'encrypted-key',
          teamId: 'team-1',
          teamName: 'Core',
          viewerName: 'Alice',
        },
      },
    });
    mockDecrypt.mockReturnValue('lin_api_decrypted');
    mockListMyIssues.mockResolvedValueOnce([
      { id: 'issue-1', identifier: 'FF-1' },
      { id: 'issue-2', identifier: 'FF-2' },
      { id: 'issue-3', identifier: 'FF-3' },
    ]);
    mockFindWorkspacesByProjectId.mockResolvedValue([
      { linearIssueId: 'issue-1', status: 'READY' },
      { linearIssueId: 'issue-3', status: 'ARCHIVED' },
    ]);

    const caller = createCaller();
    await expect(caller.listIssuesForProject({ projectId: 'p1' })).resolves.toEqual({
      issues: [
        { id: 'issue-2', identifier: 'FF-2' },
        { id: 'issue-3', identifier: 'FF-3' },
      ],
      error: null,
    });
  });

  it('gets issue details and handles errors', async () => {
    mockFindProjectById.mockResolvedValue({
      issueTrackerConfig: {
        linear: {
          apiKey: 'encrypted-key',
          teamId: 'team-1',
          teamName: 'Core',
          viewerName: 'Alice',
        },
      },
    });
    mockDecrypt.mockReturnValue('lin_api_decrypted');

    const caller = createCaller();

    mockGetIssue.mockResolvedValueOnce({ id: 'FF-1', title: 'Fix tests' });
    await expect(caller.getIssue({ projectId: 'p1', issueId: 'FF-1' })).resolves.toEqual({
      issue: { id: 'FF-1', title: 'Fix tests' },
      error: null,
    });

    mockGetIssue.mockRejectedValueOnce(new Error('not reachable'));
    await expect(caller.getIssue({ projectId: 'p1', issueId: 'FF-2' })).resolves.toEqual({
      issue: null,
      error: 'not reachable',
    });
  });
});
