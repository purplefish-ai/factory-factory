import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindProjectById = vi.hoisted(() => vi.fn());
const mockValidateKeyAndListTeams = vi.hoisted(() => vi.fn());
const mockListMyIssues = vi.hoisted(() => vi.fn());
const mockGetIssue = vi.hoisted(() => vi.fn());
const mockDecrypt = vi.hoisted(() => vi.fn());

vi.mock('@/backend/domains/workspace', () => ({
  projectManagementService: {
    findById: (...args: unknown[]) => mockFindProjectById(...args),
  },
}));

vi.mock('@/backend/domains/linear', () => ({
  linearClientService: {
    validateKeyAndListTeams: (...args: unknown[]) => mockValidateKeyAndListTeams(...args),
    listMyIssues: (...args: unknown[]) => mockListMyIssues(...args),
    getIssue: (...args: unknown[]) => mockGetIssue(...args),
  },
}));

vi.mock('@/backend/services/crypto.service', () => ({
  cryptoService: {
    decrypt: (...args: unknown[]) => mockDecrypt(...args),
  },
}));

import { linearRouter } from './linear.trpc';

function createCaller() {
  return linearRouter.createCaller({ appContext: {} } as never);
}

describe('linearRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
