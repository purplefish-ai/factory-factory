import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFile = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLoggerDebug = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    get info() {
      return mockLoggerInfo;
    },
    get debug() {
      return mockLoggerDebug;
    },
    get warn() {
      return mockLoggerWarn;
    },
    get error() {
      return mockLoggerError;
    },
  }),
}));

import { execFile } from 'node:child_process';
import { githubCLIService } from './github-cli.service';
import { classifyError } from './github-cli/errors';

vi.mocked(execFile).mockImplementation(mockExecFile as never);

function mockFullDetails(data: {
  reviews: Array<{
    id: string;
    author: { login: string };
    state: string;
    submittedAt: string | null;
    body?: string;
  }>;
}) {
  mockExecFile.mockImplementation((_command, args: string[]) =>
    Promise.resolve({
      stdout: JSON.stringify(
        args[0] === 'api'
          ? [
              data.reviews.map((review) => ({
                node_id: review.id,
                user: review.author,
                state: review.state,
                submitted_at: review.submittedAt,
                body: review.body,
              })),
            ]
          : data
      ),
      stderr: '',
    })
  );
}

const coreMetadata = {
  title: 'PR',
  url: 'https://github.com/owner/repo/pull/42',
  updatedAt: '2026-01-01T00:00:00Z',
  headRefName: 'feature',
  baseRefName: 'main',
  mergeStateStatus: 'CLEAN',
};

describe('GitHubCLIService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    githubCLIService.clearCaches();
  });

  describe('extractPRInfo', () => {
    it('should extract PR info from valid GitHub URL', () => {
      const result = githubCLIService.extractPRInfo('https://github.com/owner/repo/pull/123');

      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        number: 123,
      });
    });

    it('should extract PR info from GitHub URL with /files suffix', () => {
      const result = githubCLIService.extractPRInfo('https://github.com/owner/repo/pull/456/files');

      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        number: 456,
      });
    });

    it('should return null for invalid URL', () => {
      const result = githubCLIService.extractPRInfo('https://example.com/invalid');

      expect(result).toBeNull();
    });
  });

  describe('checkHealth', () => {
    it('should return installed and authenticated when gh CLI is ready', async () => {
      mockExecFile
        .mockResolvedValueOnce({
          stdout: 'gh version 2.20.0 (2023-10-10)\n',
          stderr: '',
        })
        .mockResolvedValueOnce({
          stdout: 'Logged in to github.com as user\n',
          stderr: '',
        });

      const result = await githubCLIService.checkHealth();

      expect(result).toEqual({
        isInstalled: true,
        isAuthenticated: true,
        version: '2.20.0',
      });
    });

    it('should return not authenticated when gh auth status fails', async () => {
      mockExecFile
        .mockResolvedValueOnce({
          stdout: 'gh version 2.20.0 (2023-10-10)\n',
          stderr: '',
        })
        .mockRejectedValueOnce(new Error('not logged in'));

      const result = await githubCLIService.checkHealth();

      expect(result).toEqual({
        isInstalled: true,
        isAuthenticated: false,
        version: '2.20.0',
        error: 'GitHub CLI is not authenticated. Run `gh auth login` to authenticate.',
        errorType: 'auth_required',
      });
    });

    it('should return not installed when gh CLI is not found', async () => {
      mockExecFile.mockRejectedValue(new Error('spawn gh ENOENT'));

      const result = await githubCLIService.checkHealth();

      expect(result).toEqual({
        isInstalled: false,
        isAuthenticated: false,
        error: 'GitHub CLI (gh) is not installed. Install from https://cli.github.com/',
        errorType: 'cli_not_installed',
      });
    });
  });

  describe('classifyError', () => {
    it('classifies bad credentials and auth refresh hints as auth_required', () => {
      expect(
        classifyError(
          new Error(
            'HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth refresh -h github.com'
          )
        )
      ).toBe('auth_required');
    });
  });

  describe('schema validation', () => {
    describe('listIssues with malformed data', () => {
      it('should throw error when array items are missing required fields', async () => {
        const malformedData = [
          {
            number: 1,
            title: 'Issue 1',
          },
        ];

        mockExecFile.mockResolvedValue({
          stdout: JSON.stringify(malformedData),
          stderr: '',
        });

        await expect(githubCLIService.listIssues('owner', 'repo')).rejects.toThrow(
          'Invalid gh CLI response for listIssues'
        );
      });

      it('should throw error when response is not an array', async () => {
        const malformedData = {
          issues: [], // should be array at top level, not nested
        };

        mockExecFile.mockResolvedValue({
          stdout: JSON.stringify(malformedData),
          stderr: '',
        });

        await expect(githubCLIService.listIssues('owner', 'repo')).rejects.toThrow(
          'Invalid gh CLI response for listIssues'
        );
      });
    });

    describe('getReviewComments with malformed data', () => {
      it('should throw error when comment structure is invalid', async () => {
        const malformedData = [
          {
            id: 1,
            user: { login: 'user1' },
            body: 'comment body',
            path: 'file.ts',
            line: 10,
            created_at: '2024-01-01T00:00:00Z',
            // missing updated_at and html_url
          },
        ];

        mockExecFile.mockResolvedValue({
          stdout: JSON.stringify(malformedData),
          stderr: '',
        });

        await expect(githubCLIService.getReviewComments('owner/repo', 123)).rejects.toThrow(
          'Invalid gh CLI response for getReviewComments'
        );
      });
    });

    describe('getPRFullDetails with malformed data', () => {
      it('accepts DRAFT mergeStateStatus for draft PRs', async () => {
        const fullPRData = {
          number: 123,
          title: 'Draft PR',
          url: 'https://github.com/owner/repo/pull/123',
          author: { login: 'octocat' },
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
          isDraft: true,
          state: 'OPEN',
          reviewDecision: null,
          statusCheckRollup: null,
          reviews: [],
          comments: [],
          labels: [],
          additions: 10,
          deletions: 2,
          changedFiles: 1,
          headRefName: 'feature-branch',
          baseRefName: 'main',
          mergeStateStatus: 'DRAFT',
        };

        mockFullDetails(fullPRData);

        const result = await githubCLIService.getPRFullDetails('owner/repo', 123);

        expect(result.mergeStateStatus).toBe('DRAFT');
      });

      it('normalizes status check casing in statusCheckRollup entries', async () => {
        const fullPRData = {
          number: 123,
          title: 'Test PR',
          url: 'https://github.com/owner/repo/pull/123',
          author: { login: 'octocat' },
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
          isDraft: false,
          state: 'OPEN',
          reviewDecision: null,
          statusCheckRollup: [
            {
              __typename: 'StatusContext',
              context: 'ci/legacy-status',
              state: 'pending',
              targetUrl: 'https://example.com/checks/legacy-status',
            },
            {
              __typename: 'StatusContext',
              context: 'ci/legacy-required',
              state: 'error',
            },
            {
              __typename: 'CheckRun',
              name: 'ci/modern-check',
              status: 'completed',
              conclusion: 'cancelled',
            },
          ],
          reviews: [],
          comments: [],
          labels: [],
          additions: 10,
          deletions: 2,
          changedFiles: 1,
          headRefName: 'feature-branch',
          baseRefName: 'main',
          mergeStateStatus: 'CLEAN',
        };

        mockFullDetails(fullPRData);

        const result = await githubCLIService.getPRFullDetails('owner/repo', 123);

        expect(result.statusCheckRollup).toEqual([
          {
            __typename: 'StatusContext',
            name: 'ci/legacy-status',
            status: 'PENDING',
            conclusion: null,
            detailsUrl: 'https://example.com/checks/legacy-status',
          },
          {
            __typename: 'StatusContext',
            name: 'ci/legacy-required',
            status: 'COMPLETED',
            conclusion: 'FAILURE',
            detailsUrl: undefined,
          },
          {
            __typename: 'CheckRun',
            name: 'ci/modern-check',
            status: 'COMPLETED',
            conclusion: 'CANCELLED',
            detailsUrl: undefined,
          },
        ]);
      });

      it('should accept reviews with null submittedAt', async () => {
        const fullPRData = {
          number: 123,
          title: 'Test PR',
          url: 'https://github.com/owner/repo/pull/123',
          author: { login: 'octocat' },
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
          isDraft: false,
          state: 'OPEN',
          reviewDecision: null,
          statusCheckRollup: null,
          reviews: [
            {
              id: 'review-1',
              author: { login: 'reviewer' },
              state: 'PENDING',
              submittedAt: null,
            },
          ],
          comments: [],
          labels: [],
          additions: 10,
          deletions: 2,
          changedFiles: 1,
          headRefName: 'feature-branch',
          baseRefName: 'main',
          mergeStateStatus: 'CLEAN',
        };

        mockFullDetails(fullPRData);

        const result = await githubCLIService.getPRFullDetails('owner/repo', 123);

        expect(result.reviews).toEqual([
          {
            id: 'review-1',
            author: { login: 'reviewer' },
            state: 'PENDING',
            submittedAt: null,
            body: undefined,
            chronologicalOrder: 0,
          },
        ]);
      });

      it('should throw error when full PR details are incomplete', async () => {
        const malformedData = {
          number: 123,
          title: 'Test PR',
          // missing many required fields
        };

        mockExecFile.mockResolvedValue({
          stdout: JSON.stringify(malformedData),
          stderr: '',
        });

        await expect(githubCLIService.getPRFullDetails('owner/repo', 123)).rejects.toThrow(
          'Invalid gh CLI response for getPRFullDetails'
        );
      });
    });
  });

  describe('listOpenPRs', () => {
    const page = (
      nodes: Array<{
        number: number;
        url: string;
        createdAt: string;
        headRefName?: string;
      }>,
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
    ) =>
      JSON.stringify({
        data: {
          repository: {
            pullRequests: { nodes, pageInfo },
          },
        },
      });

    it('lists open pull requests through the repository connection', async () => {
      const prs = [
        {
          number: 11,
          url: 'https://github.com/Owner/Repo/pull/11',
          createdAt: '2024-01-02T00:00:00Z',
          headRefName: 'feature/one',
        },
      ];
      mockExecFile.mockResolvedValue({
        stdout: page(prs, { hasNextPage: false, endCursor: null }),
        stderr: '',
      });

      await expect(githubCLIService.listOpenPRs('Owner', 'Repo')).resolves.toEqual(prs);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
      expect(mockExecFile).toHaveBeenCalledWith(
        'gh',
        [
          'api',
          'graphql',
          '-f',
          expect.stringContaining('repository(owner: "Owner", name: "Repo")'),
        ],
        expect.objectContaining({ timeout: expect.any(Number) })
      );
    });

    it('continues paging beyond 1,000 open pull requests', async () => {
      for (let pageIndex = 0; pageIndex < 11; pageIndex++) {
        const prs = Array.from({ length: 100 }, (_, itemIndex) => {
          const number = pageIndex * 100 + itemIndex + 1;
          return {
            number,
            url: `https://github.com/owner/repo/pull/${number}`,
            createdAt: '2024-01-02T00:00:00Z',
            headRefName: `feature/${number}`,
          };
        });
        mockExecFile.mockResolvedValueOnce({
          stdout: page(prs, {
            hasNextPage: pageIndex < 10,
            endCursor: pageIndex < 10 ? `cursor-${pageIndex + 1}` : null,
          }),
          stderr: '',
        });
      }

      const result = await githubCLIService.listOpenPRs('owner', 'repo');

      expect(result).toHaveLength(1100);
      expect(result.at(-1)).toMatchObject({ number: 1100, headRefName: 'feature/1100' });
      expect(mockExecFile).toHaveBeenCalledTimes(11);
      expect(mockExecFile).toHaveBeenLastCalledWith(
        'gh',
        ['api', 'graphql', '-f', expect.stringContaining('after: "cursor-10"')],
        expect.objectContaining({ timeout: expect.any(Number) })
      );
    });

    it('rejects malformed repository pull request data', async () => {
      mockExecFile.mockResolvedValue({
        stdout: page(
          [
            {
              number: 11,
              url: 'https://github.com/owner/repo/pull/11',
              createdAt: '2024-01-02T00:00:00Z',
            },
          ],
          { hasNextPage: false, endCursor: null }
        ),
        stderr: '',
      });

      await expect(githubCLIService.listOpenPRs('owner', 'repo')).rejects.toThrow();
    });

    it('propagates repository listing failures', async () => {
      mockExecFile.mockRejectedValue(new Error('repository unavailable'));

      await expect(githubCLIService.listOpenPRs('owner', 'repo')).rejects.toThrow(
        'repository unavailable'
      );
    });
  });

  describe('getAuthenticatedUsername', () => {
    it('should return username when authenticated', async () => {
      mockExecFile.mockResolvedValue({ stdout: 'testuser\n', stderr: '' });

      const result = await githubCLIService.getAuthenticatedUsername();
      expect(result).toBe('testuser');
    });

    it('should return null on empty stdout', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await githubCLIService.getAuthenticatedUsername();
      expect(result).toBeNull();
    });

    it('should return null when CLI fails', async () => {
      mockExecFile.mockRejectedValue(new Error('not authenticated'));

      const result = await githubCLIService.getAuthenticatedUsername();
      expect(result).toBeNull();
    });
  });

  describe('getReviewComments', () => {
    it('should return empty array when stdout is empty', async () => {
      mockExecFile.mockResolvedValue({ stdout: '  ', stderr: '' });

      const result = await githubCLIService.getReviewComments('owner/repo', 123);
      expect(result).toEqual([]);
    });

    it('should map review comments correctly', async () => {
      const comments = [
        {
          id: 1,
          user: { login: 'reviewer' },
          body: 'Fix this',
          path: 'src/index.ts',
          line: 42,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
          html_url: 'https://github.com/o/r/pull/1#comment-1',
        },
      ];

      mockExecFile.mockResolvedValue({ stdout: JSON.stringify(comments), stderr: '' });

      const result = await githubCLIService.getReviewComments('owner/repo', 123);
      expect(result).toEqual([
        {
          id: 1,
          author: { login: 'reviewer' },
          body: 'Fix this',
          path: 'src/index.ts',
          line: 42,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
          url: 'https://github.com/o/r/pull/1#comment-1',
        },
      ]);
    });
  });

  describe('getResolvedReviewCommentIds', () => {
    function makeCommentsConnection(
      commentIds: Array<number | null>,
      pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
        hasNextPage: false,
        endCursor: null,
      }
    ) {
      return {
        pageInfo,
        nodes: commentIds.map((id) => ({
          fullDatabaseId: id === null ? null : String(id),
        })),
      };
    }

    function makeReviewThreadsResponse(
      threads: Array<{
        isResolved: boolean;
        commentIds: Array<number | null>;
        commentsPageInfo?: { hasNextPage: boolean; endCursor: string | null };
      }>,
      pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
        hasNextPage: false,
        endCursor: null,
      }
    ) {
      return {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo,
                nodes: threads.map((thread, index) => ({
                  id: `thread-${index}`,
                  isResolved: thread.isResolved,
                  comments: makeCommentsConnection(thread.commentIds, thread.commentsPageInfo),
                })),
              },
            },
          },
        },
      };
    }

    it('returns comment ids from resolved threads only', async () => {
      mockExecFile.mockResolvedValue({
        stdout: JSON.stringify(
          makeReviewThreadsResponse([
            { isResolved: true, commentIds: [1, 2] },
            { isResolved: false, commentIds: [3] },
            { isResolved: true, commentIds: [3_590_714_831, null] },
          ])
        ),
        stderr: '',
      });

      const result = await githubCLIService.getResolvedReviewCommentIds('owner/repo', 123);
      expect(result).toEqual(new Set([1, 2, 3_590_714_831]));
    });

    it('paginates review threads until hasNextPage is false', async () => {
      mockExecFile
        .mockResolvedValueOnce({
          stdout: JSON.stringify(
            makeReviewThreadsResponse([{ isResolved: true, commentIds: [1] }], {
              hasNextPage: true,
              endCursor: 'cursor-1',
            })
          ),
          stderr: '',
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify(
            makeReviewThreadsResponse([{ isResolved: true, commentIds: [2] }])
          ),
          stderr: '',
        });

      const result = await githubCLIService.getResolvedReviewCommentIds('owner/repo', 123);
      expect(result).toEqual(new Set([1, 2]));
      expect(mockExecFile).toHaveBeenCalledTimes(2);
      const secondQuery = mockExecFile.mock.calls[1]?.[1]?.join(' ');
      expect(secondQuery).toContain('after: "cursor-1"');
    });

    it('pages through a resolved thread with more than one page of comments', async () => {
      mockExecFile
        .mockResolvedValueOnce({
          stdout: JSON.stringify(
            makeReviewThreadsResponse([
              {
                isResolved: true,
                commentIds: [1],
                commentsPageInfo: { hasNextPage: true, endCursor: 'comment-cursor-1' },
              },
              { isResolved: false, commentIds: [2] },
            ])
          ),
          stderr: '',
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            data: {
              node: {
                comments: makeCommentsConnection([3], {
                  hasNextPage: true,
                  endCursor: 'comment-cursor-2',
                }),
              },
            },
          }),
          stderr: '',
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            data: { node: { comments: makeCommentsConnection([4]) } },
          }),
          stderr: '',
        });

      const result = await githubCLIService.getResolvedReviewCommentIds('owner/repo', 123);
      expect(result).toEqual(new Set([1, 3, 4]));
      expect(mockExecFile).toHaveBeenCalledTimes(3);
      const tailQuery = mockExecFile.mock.calls[1]?.[1]?.join(' ');
      expect(tailQuery).toContain('node(id: "thread-0")');
      expect(tailQuery).toContain('after: "comment-cursor-1"');
      const secondTailQuery = mockExecFile.mock.calls[2]?.[1]?.join(' ');
      expect(secondTailQuery).toContain('after: "comment-cursor-2"');
    });

    it('returns an empty set when the PR is not found', async () => {
      mockExecFile.mockResolvedValue({
        stdout: JSON.stringify({ data: { repository: { pullRequest: null } } }),
        stderr: '',
      });

      const result = await githubCLIService.getResolvedReviewCommentIds('owner/repo', 123);
      expect(result).toEqual(new Set());
    });

    it('wraps non-connectivity CLI failures with context', async () => {
      mockExecFile.mockRejectedValue(new Error('lookup failed'));

      await expect(githubCLIService.getResolvedReviewCommentIds('owner/repo', 123)).rejects.toThrow(
        'Failed to fetch resolved review threads: lookup failed'
      );
    });

    it('throws on an invalid repo format', async () => {
      await expect(githubCLIService.getResolvedReviewCommentIds('bad-repo', 123)).rejects.toThrow(
        'Invalid repo format'
      );
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });

  describe('checkHealth edge cases', () => {
    it('should return generic error for non-installation failures', async () => {
      mockExecFile.mockRejectedValue(new Error('something weird'));

      const result = await githubCLIService.checkHealth();
      expect(result.isInstalled).toBe(false);
      expect(result.error).toContain('something weird');
    });

    it('should extract version from gh version output', async () => {
      mockExecFile
        .mockResolvedValueOnce({
          stdout: 'gh version 3.1.2 (2025-06-15)\nhttps://github.com/cli/cli/releases/tag/v3.1.2\n',
          stderr: '',
        })
        .mockResolvedValueOnce({ stdout: 'Logged in', stderr: '' });

      const result = await githubCLIService.checkHealth();
      expect(result.version).toBe('3.1.2');
    });
  });

  describe('higher-level service methods', () => {
    it('lists review requests via single GraphQL call', async () => {
      mockExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            search: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  number: 12,
                  title: 'Fix bug',
                  url: 'https://github.com/o/r/pull/12',
                  repository: { nameWithOwner: 'o/r' },
                  author: { login: 'alice' },
                  createdAt: '2026-01-10T00:00:00Z',
                  isDraft: false,
                  reviewDecision: 'APPROVED',
                  additions: 10,
                  deletions: 3,
                  changedFiles: 2,
                },
              ],
            },
          },
        }),
        stderr: '',
      });

      await expect(githubCLIService.listReviewRequests()).resolves.toEqual([
        {
          number: 12,
          title: 'Fix bug',
          url: 'https://github.com/o/r/pull/12',
          repository: { nameWithOwner: 'o/r' },
          author: { login: 'alice' },
          createdAt: '2026-01-10T00:00:00Z',
          isDraft: false,
          reviewDecision: 'APPROVED',
          additions: 10,
          deletions: 3,
          changedFiles: 2,
        },
      ]);

      // Only one execFile call — no N+1
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it('paginates review requests until GitHub search has no next page', async () => {
      mockExecFile
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            data: {
              search: {
                pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
                nodes: [
                  {
                    number: 50,
                    title: 'Boundary PR',
                    url: 'https://github.com/o/r/pull/50',
                    repository: { nameWithOwner: 'o/r' },
                    author: { login: 'alice' },
                    createdAt: '2026-01-10T00:00:00Z',
                    isDraft: false,
                    reviewDecision: null,
                    additions: 1,
                    deletions: 2,
                    changedFiles: 3,
                  },
                ],
              },
            },
          }),
          stderr: '',
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            data: {
              search: {
                pageInfo: { hasNextPage: false, endCursor: 'cursor-2' },
                nodes: [
                  {
                    number: 51,
                    title: 'Overflow PR',
                    url: 'https://github.com/o/r/pull/51',
                    repository: { nameWithOwner: 'o/r' },
                    author: null,
                    createdAt: '2026-01-11T00:00:00Z',
                    isDraft: true,
                  },
                ],
              },
            },
          }),
          stderr: '',
        });

      await expect(githubCLIService.listReviewRequests()).resolves.toEqual([
        {
          number: 50,
          title: 'Boundary PR',
          url: 'https://github.com/o/r/pull/50',
          repository: { nameWithOwner: 'o/r' },
          author: { login: 'alice' },
          createdAt: '2026-01-10T00:00:00Z',
          isDraft: false,
          reviewDecision: null,
          additions: 1,
          deletions: 2,
          changedFiles: 3,
        },
        {
          number: 51,
          title: 'Overflow PR',
          url: 'https://github.com/o/r/pull/51',
          repository: { nameWithOwner: 'o/r' },
          author: { login: '' },
          createdAt: '2026-01-11T00:00:00Z',
          isDraft: true,
          reviewDecision: null,
          additions: 0,
          deletions: 0,
          changedFiles: 0,
        },
      ]);

      expect(mockExecFile).toHaveBeenCalledTimes(2);
      expect(mockExecFile.mock.calls[1]?.[1]).toEqual(
        expect.arrayContaining([expect.stringContaining('after: "cursor-1"')])
      );
    });

    it('caps review request pagination at 20 pages', async () => {
      const continuingPage = {
        stdout: JSON.stringify({
          data: {
            search: {
              pageInfo: { hasNextPage: true, endCursor: 'repeated-cursor' },
              nodes: [],
            },
          },
        }),
        stderr: '',
      };

      for (let page = 0; page < 20; page++) {
        mockExecFile.mockResolvedValueOnce(continuingPage);
      }
      mockExecFile.mockRejectedValueOnce(new Error('unexpected 21st page request'));

      try {
        await expect(githubCLIService.listReviewRequests()).resolves.toEqual([]);

        expect(mockExecFile).toHaveBeenCalledTimes(20);
        expect(mockLoggerWarn).toHaveBeenCalledWith(
          'listReviewRequests: reached MAX_PAGES limit, results may be incomplete',
          {
            totalFetched: 0,
            maxPages: 20,
          }
        );
      } finally {
        mockExecFile.mockReset();
      }
    });

    it('falls back to empty array when GraphQL response is malformed', async () => {
      mockExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify({ data: { search: { nodes: 'not-an-array' } } }),
        stderr: '',
      });

      await expect(githubCLIService.listReviewRequests()).resolves.toEqual([]);
    });

    it('keeps fetched review requests when a later GraphQL page is malformed', async () => {
      mockExecFile
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            data: {
              search: {
                pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
                nodes: [
                  {
                    number: 50,
                    title: 'Boundary PR',
                    url: 'https://github.com/o/r/pull/50',
                    repository: { nameWithOwner: 'o/r' },
                    author: { login: 'alice' },
                    createdAt: '2026-01-10T00:00:00Z',
                    isDraft: false,
                    reviewDecision: null,
                    additions: 1,
                    deletions: 2,
                    changedFiles: 3,
                  },
                ],
              },
            },
          }),
          stderr: '',
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({ data: { search: { nodes: 'not-an-array' } } }),
          stderr: '',
        });

      await expect(githubCLIService.listReviewRequests()).resolves.toEqual([
        {
          number: 50,
          title: 'Boundary PR',
          url: 'https://github.com/o/r/pull/50',
          repository: { nameWithOwner: 'o/r' },
          author: { login: 'alice' },
          createdAt: '2026-01-10T00:00:00Z',
          isDraft: false,
          reviewDecision: null,
          additions: 1,
          deletions: 2,
          changedFiles: 3,
        },
      ]);
    });

    it('gets PR diff and maps failures', async () => {
      mockExecFile.mockResolvedValueOnce({ stdout: 'diff --git a b', stderr: '' });
      await expect(githubCLIService.getPRDiff('o/r', 8)).resolves.toBe('diff --git a b');

      mockExecFile.mockRejectedValueOnce(new Error('diff failed'));
      await expect(githubCLIService.getPRDiff('o/r', 8)).rejects.toThrow(
        'Failed to fetch PR diff: diff failed'
      );
    });

    it('submits PR reviews for each action and includes body for comment-like actions', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
      await expect(githubCLIService.submitReview('o/r', 5, 'approve')).resolves.toBeUndefined();
      await expect(
        githubCLIService.submitReview('o/r', 5, 'request-changes', 'Needs changes')
      ).resolves.toBeUndefined();
      await expect(
        githubCLIService.submitReview('o/r', 5, 'comment', 'Looks good')
      ).resolves.toBeUndefined();

      expect(mockExecFile).toHaveBeenNthCalledWith(
        1,
        'gh',
        ['pr', 'review', '5', '--repo', 'o/r', '--approve'],
        expect.objectContaining({ timeout: expect.any(Number) })
      );
      expect(mockExecFile).toHaveBeenNthCalledWith(
        2,
        'gh',
        ['pr', 'review', '5', '--repo', 'o/r', '--request-changes', '--body', 'Needs changes'],
        expect.objectContaining({ timeout: expect.any(Number) })
      );
      expect(mockExecFile).toHaveBeenNthCalledWith(
        3,
        'gh',
        ['pr', 'review', '5', '--repo', 'o/r', '--comment', '--body', 'Looks good'],
        expect.objectContaining({ timeout: expect.any(Number) })
      );

      mockExecFile.mockRejectedValueOnce(new Error('review failed'));
      await expect(githubCLIService.submitReview('o/r', 5, 'approve')).rejects.toThrow(
        'Failed to submit review: review failed'
      );
    });

    it('lists issues with assignee filter and raises mapped errors', async () => {
      mockExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 1,
            title: 'Issue 1',
            body: 'body',
            url: 'https://github.com/o/r/issues/1',
            state: 'OPEN',
            createdAt: '2026-02-01T00:00:00Z',
            author: { login: 'alice' },
          },
        ]),
        stderr: '',
      });

      await expect(
        githubCLIService.listIssues('o', 'r', { limit: 20, assignee: '@me' })
      ).resolves.toEqual([
        {
          number: 1,
          title: 'Issue 1',
          body: 'body',
          url: 'https://github.com/o/r/issues/1',
          state: 'OPEN',
          createdAt: '2026-02-01T00:00:00Z',
          author: { login: 'alice' },
        },
      ]);

      expect(mockExecFile).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['--assignee', '@me']),
        expect.objectContaining({ timeout: expect.any(Number) })
      );

      const failure = Object.assign(new Error('Command failed: gh -R o/authentication'), {
        stderr: 'HTTP 502: Bad Gateway',
      });
      mockExecFile.mockRejectedValueOnce(failure);
      const error = await githubCLIService.listIssues('o', 'authentication').catch((e) => e);
      expect(error).toMatchObject({ message: 'Failed to list issues: HTTP 502: Bad Gateway' });
      expect(error.cause).toBe(failure);
      expect(classifyError(error)).toBe('unknown');
    });

    it('adds PR and issue comments and maps write failures', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
      await expect(githubCLIService.addPRComment('o/r', 2, 'hello')).resolves.toBeUndefined();
      await expect(githubCLIService.addIssueComment('o', 'r', 3, 'hello')).resolves.toBeUndefined();

      mockExecFile.mockRejectedValueOnce(new Error('pr comment failed'));
      await expect(githubCLIService.addPRComment('o/r', 2, 'hello')).rejects.toThrow(
        'Failed to add PR comment: pr comment failed'
      );

      mockExecFile.mockRejectedValueOnce(new Error('issue comment failed'));
      await expect(githubCLIService.addIssueComment('o', 'r', 3, 'hello')).rejects.toThrow(
        'Failed to add issue comment: issue comment failed'
      );
    });

    it('gets issues with success and error branches', async () => {
      mockExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 7,
          title: 'Issue 7',
          body: 'details',
          url: 'https://github.com/o/r/issues/7',
          state: 'OPEN',
          createdAt: '2026-02-01T00:00:00Z',
          author: { login: 'alice' },
        }),
        stderr: '',
      });
      await expect(githubCLIService.getIssue('o', 'r', 7)).resolves.toEqual({
        number: 7,
        title: 'Issue 7',
        body: 'details',
        url: 'https://github.com/o/r/issues/7',
        state: 'OPEN',
        createdAt: '2026-02-01T00:00:00Z',
        author: { login: 'alice' },
      });

      mockExecFile.mockRejectedValueOnce(new Error('issue lookup failed'));
      await expect(githubCLIService.getIssue('o', 'r', 7)).resolves.toBeNull();
    });
  });

  describe('centralized exec - singleflight dedup', () => {
    it('passes abort signals to authenticated-user lookups', async () => {
      const controller = new AbortController();
      mockExecFile.mockResolvedValue({ stdout: 'octocat\n', stderr: '' });

      await expect(githubCLIService.getAuthenticatedUsername(controller.signal)).resolves.toBe(
        'octocat'
      );

      expect(mockExecFile).toHaveBeenCalledWith(
        'gh',
        ['api', 'user', '--jq', '.login'],
        expect.objectContaining({ signal: controller.signal })
      );
    });

    it('passes abort signals to review comment child processes', async () => {
      const controller = new AbortController();
      mockExecFile.mockResolvedValue({ stdout: '[]', stderr: '' });

      await githubCLIService.getReviewComments('owner/repo', 42, undefined, controller.signal);

      expect(mockExecFile).toHaveBeenCalledWith(
        'gh',
        expect.any(Array),
        expect.objectContaining({ signal: controller.signal })
      );
    });

    it('deduplicates identical concurrent read calls', async () => {
      const mockPRData = {
        ...coreMetadata,
        number: 42,
        state: 'OPEN',
        isDraft: false,
        reviewDecision: null,
        statusCheckRollup: [],
      };

      mockExecFile.mockResolvedValue({
        stdout: JSON.stringify(mockPRData),
        stderr: '',
      });

      // Fire two identical calls concurrently
      const [result1, result2] = await Promise.all([
        githubCLIService.getPRStatusDetails('owner/repo', 42),
        githubCLIService.getPRStatusDetails('owner/repo', 42),
      ]);

      // Both should succeed with same data
      expect(result1).toEqual(mockPRData);
      expect(result2).toEqual(mockPRData);

      // But execFile should only have been called once (singleflight)
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it('does not deduplicate calls with different args', async () => {
      const makePRData = (num: number) => ({
        ...coreMetadata,
        number: num,
        state: 'OPEN',
        isDraft: false,
        reviewDecision: null,
        statusCheckRollup: [],
      });

      mockExecFile
        .mockResolvedValueOnce({ stdout: JSON.stringify(makePRData(1)), stderr: '' })
        .mockResolvedValueOnce({ stdout: JSON.stringify(makePRData(2)), stderr: '' });

      const [result1, result2] = await Promise.all([
        githubCLIService.getPRStatusDetails('owner/repo', 1),
        githubCLIService.getPRStatusDetails('owner/repo', 2),
      ]);

      expect(result1?.number).toBe(1);
      expect(result2?.number).toBe(2);
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    it('removes inflight entry after resolution so subsequent calls spawn new process', async () => {
      const mockPRData = {
        ...coreMetadata,
        number: 10,
        state: 'OPEN',
        isDraft: false,
        reviewDecision: null,
        statusCheckRollup: [],
      };

      mockExecFile.mockResolvedValue({ stdout: JSON.stringify(mockPRData), stderr: '' });

      // First call
      await githubCLIService.getPRStatusDetails('owner/repo', 10);
      // Second call (sequential, not concurrent)
      await githubCLIService.getPRStatusDetails('owner/repo', 10);

      // Each sequential call should spawn its own process
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    it('shares rejection across deduplicated callers', async () => {
      const error = new Error('some unexpected error');
      mockExecFile.mockRejectedValue(error);
      const results = await Promise.allSettled([
        githubCLIService.getPRStatusDetails('owner/repo', 99),
        githubCLIService.getPRStatusDetails('owner/repo', 99),
      ]);

      expect(results).toEqual([
        { status: 'rejected', reason: error },
        { status: 'rejected', reason: error },
      ]);

      // Only one process should have been spawned
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('centralized exec - mutating calls', () => {
    it('does not deduplicate mutating calls with same args', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

      await Promise.all([
        githubCLIService.submitReview('owner/repo', 5, 'approve'),
        githubCLIService.submitReview('owner/repo', 5, 'approve'),
      ]);

      // Both calls should spawn separate processes (no dedup for writes)
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });
  });
});
