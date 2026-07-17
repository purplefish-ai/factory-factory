import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies before importing the service
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

// Import after mocks are set up
import { execFile } from 'node:child_process';
import { deriveCiStatusFromCheckRollup } from '@/shared/core';
import { classifyError } from './github-cli/errors';
import { githubCLIService } from './github-cli.service';

vi.mocked(execFile).mockImplementation(mockExecFile as never);

describe('GitHubCLIService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    githubCLIService.clearCaches();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getPRStatus', () => {
    it('should return PR status when gh CLI succeeds', async () => {
      const mockPRData = {
        number: 123,
        state: 'OPEN',
        isDraft: false,
        reviewDecision: 'APPROVED',
        statusCheckRollup: [],
      };

      mockExecFile.mockResolvedValue({
        stdout: JSON.stringify(mockPRData),
        stderr: '',
      });

      const result = await githubCLIService.getPRStatus('https://github.com/owner/repo/pull/123');

      expect(result).toEqual({
        number: 123,
        state: 'OPEN',
        isDraft: false,
        reviewDecision: 'APPROVED',
        statusCheckRollup: [],
      });
    });

    it('should return null and log error when CLI is not installed', async () => {
      mockExecFile.mockRejectedValue(new Error('spawn gh ENOENT'));

      const result = await githubCLIService.getPRStatus('https://github.com/owner/repo/pull/123');

      expect(result).toBeNull();
      expect(mockLoggerError).toHaveBeenCalledWith(
        'GitHub CLI configuration issue',
        expect.objectContaining({
          errorType: 'cli_not_installed',
          hint: 'Install gh CLI from https://cli.github.com/',
        })
      );
    });

    it('should return null and log error when authentication is required', async () => {
      mockExecFile.mockRejectedValue(new Error('gh auth login required'));

      const result = await githubCLIService.getPRStatus('https://github.com/owner/repo/pull/123');

      expect(result).toBeNull();
      expect(mockLoggerError).toHaveBeenCalledWith(
        'GitHub CLI configuration issue',
        expect.objectContaining({
          errorType: 'auth_required',
          hint: 'Run `gh auth login` to authenticate',
        })
      );
    });

    it('should return null and log warning when PR is not found', async () => {
      mockExecFile.mockRejectedValue(new Error('could not resolve to a PullRequest'));

      const result = await githubCLIService.getPRStatus('https://github.com/owner/repo/pull/123');

      expect(result).toBeNull();
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        'PR not found',
        expect.objectContaining({
          errorType: 'pr_not_found',
        })
      );
    });

    it('should return null and log error for network issues', async () => {
      mockExecFile.mockRejectedValue(new Error('network timeout'));

      const result = await githubCLIService.getPRStatus('https://github.com/owner/repo/pull/123');

      expect(result).toBeNull();
      expect(mockLoggerError).toHaveBeenCalledWith(
        'Failed to fetch PR status via gh CLI',
        expect.objectContaining({
          errorType: 'network_error',
        })
      );
    });

    it('should return null and log error for unknown errors', async () => {
      mockExecFile.mockRejectedValue(new Error('some unexpected error'));

      const result = await githubCLIService.getPRStatus('https://github.com/owner/repo/pull/123');

      expect(result).toBeNull();
      expect(mockLoggerError).toHaveBeenCalledWith(
        'Failed to fetch PR status via gh CLI',
        expect.objectContaining({
          errorType: 'unknown',
        })
      );
    });

    it('should return null and log warning when PR URL is invalid', async () => {
      const result = await githubCLIService.getPRStatus('https://example.com/invalid');

      expect(result).toBeNull();
      expect(mockLoggerWarn).toHaveBeenCalledWith('Could not parse PR URL', {
        prUrl: 'https://example.com/invalid',
      });
    });
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

  describe('computePRState', () => {
    it('should return MERGED when PR is merged', () => {
      const status = {
        number: 123,
        state: 'MERGED' as const,
        isDraft: false,
        reviewDecision: null,
        statusCheckRollup: null,
      };

      const result = githubCLIService.computePRState(status);

      expect(result).toBe('MERGED');
    });

    it('should return CLOSED when PR is closed but not merged', () => {
      const status = {
        number: 123,
        state: 'CLOSED' as const,
        isDraft: false,
        reviewDecision: null,
        statusCheckRollup: null,
      };

      const result = githubCLIService.computePRState(status);

      expect(result).toBe('CLOSED');
    });

    it('should return DRAFT when PR is a draft', () => {
      const status = {
        number: 123,
        state: 'OPEN' as const,
        isDraft: true,
        reviewDecision: null,
        statusCheckRollup: null,
      };

      const result = githubCLIService.computePRState(status);

      expect(result).toBe('DRAFT');
    });

    it('should return APPROVED when PR is approved', () => {
      const status = {
        number: 123,
        state: 'OPEN' as const,
        isDraft: false,
        reviewDecision: 'APPROVED' as const,
        statusCheckRollup: null,
      };

      const result = githubCLIService.computePRState(status);

      expect(result).toBe('APPROVED');
    });

    it('should return CHANGES_REQUESTED when changes are requested', () => {
      const status = {
        number: 123,
        state: 'OPEN' as const,
        isDraft: false,
        reviewDecision: 'CHANGES_REQUESTED' as const,
        statusCheckRollup: null,
      };

      const result = githubCLIService.computePRState(status);

      expect(result).toBe('CHANGES_REQUESTED');
    });

    it('should return OPEN for open PR without special review state', () => {
      const status = {
        number: 123,
        state: 'OPEN' as const,
        isDraft: false,
        reviewDecision: null,
        statusCheckRollup: null,
      };

      const result = githubCLIService.computePRState(status);

      expect(result).toBe('OPEN');
    });
  });

  describe('computeCIStatus', () => {
    it('should return UNKNOWN when statusCheckRollup is null', () => {
      const result = githubCLIService.computeCIStatus(null);

      expect(result).toBe('UNKNOWN');
    });

    it('should return SUCCESS when statusCheckRollup is empty', () => {
      const result = githubCLIService.computeCIStatus([]);

      expect(result).toBe('SUCCESS');
    });

    it('should return FAILURE when any check fails', () => {
      const result = githubCLIService.computeCIStatus([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'FAILURE' },
      ]);

      expect(result).toBe('FAILURE');
    });

    it('should return PENDING when any check is pending', () => {
      const result = githubCLIService.computeCIStatus([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'QUEUED' },
      ]);

      expect(result).toBe('PENDING');
    });

    it('should return SUCCESS when all checks pass', () => {
      const result = githubCLIService.computeCIStatus([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
      ]);

      expect(result).toBe('SUCCESS');
    });

    it('should treat SKIPPED as success when paired with successful checks', () => {
      const result = githubCLIService.computeCIStatus([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'SKIPPED' },
      ]);

      expect(result).toBe('SUCCESS');
    });

    it('should treat CANCELLED as failure even when passing checks exist', () => {
      const result = githubCLIService.computeCIStatus([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'NEUTRAL' },
        { status: 'COMPLETED', conclusion: 'CANCELLED' },
      ]);

      expect(result).toBe('FAILURE');
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
    describe('getPRStatus with malformed data', () => {
      it('should return null and log error when response is missing required fields', async () => {
        const malformedData = {
          number: 123,
          // missing state, isDraft, etc.
        };

        mockExecFile.mockResolvedValue({
          stdout: JSON.stringify(malformedData),
          stderr: '',
        });

        const result = await githubCLIService.getPRStatus('https://github.com/owner/repo/pull/123');

        expect(result).toBeNull();
        expect(mockLoggerError).toHaveBeenCalledWith(
          'Invalid gh CLI JSON response',
          expect.objectContaining({
            context: 'getPRStatus',
            validationErrors: expect.any(Array),
          })
        );
      });

      it('should return null and log error when response has wrong field types', async () => {
        const malformedData = {
          number: '123', // should be number
          state: 'OPEN',
          isDraft: 'false', // should be boolean
          reviewDecision: null,
          mergedAt: null,
          updatedAt: '2024-01-01T00:00:00Z',
          statusCheckRollup: null,
        };

        mockExecFile.mockResolvedValue({
          stdout: JSON.stringify(malformedData),
          stderr: '',
        });

        const result = await githubCLIService.getPRStatus('https://github.com/owner/repo/pull/123');

        expect(result).toBeNull();
        expect(mockLoggerError).toHaveBeenCalledWith(
          'Invalid gh CLI JSON response',
          expect.objectContaining({
            context: 'getPRStatus',
          })
        );
      });

      it('should return null and log error when JSON is invalid', async () => {
        mockExecFile.mockResolvedValue({
          stdout: 'not valid json{',
          stderr: '',
        });

        const result = await githubCLIService.getPRStatus('https://github.com/owner/repo/pull/123');

        expect(result).toBeNull();
        expect(mockLoggerError).toHaveBeenCalledWith(
          'Failed to parse gh CLI JSON',
          expect.objectContaining({
            context: 'getPRStatus',
          })
        );
      });
    });

    describe('listIssues with malformed data', () => {
      it('should throw error when array items are missing required fields', async () => {
        const malformedData = [
          {
            number: 1,
            title: 'Issue 1',
            // missing body, url, state, etc.
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

        mockExecFile.mockResolvedValue({
          stdout: JSON.stringify(fullPRData),
          stderr: '',
        });

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

        mockExecFile.mockResolvedValue({
          stdout: JSON.stringify(fullPRData),
          stderr: '',
        });

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

        mockExecFile.mockResolvedValue({
          stdout: JSON.stringify(fullPRData),
          stderr: '',
        });

        const result = await githubCLIService.getPRFullDetails('owner/repo', 123);

        expect(result.reviews).toEqual([
          {
            id: 'review-1',
            author: { login: 'reviewer' },
            state: 'PENDING',
            submittedAt: null,
            body: undefined,
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

  describe('computeCIStatus edge cases', () => {
    it('should return FAILURE for ERROR state in legacy format', () => {
      const result = githubCLIService.computeCIStatus([{ state: 'ERROR' }]);
      expect(result).toBe('FAILURE');
    });

    it('should return FAILURE for ACTION_REQUIRED conclusion', () => {
      const result = githubCLIService.computeCIStatus([
        { status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' },
      ]);
      expect(result).toBe('FAILURE');
    });

    it('should return PENDING for IN_PROGRESS status', () => {
      const result = githubCLIService.computeCIStatus([{ status: 'IN_PROGRESS' }]);
      expect(result).toBe('PENDING');
    });

    it('should return PENDING for lowercase in_progress status', () => {
      const result = githubCLIService.computeCIStatus([{ status: 'in_progress' }]);
      expect(result).toBe('PENDING');
    });

    it('should return PENDING for EXPECTED legacy state', () => {
      const result = githubCLIService.computeCIStatus([{ state: 'EXPECTED' }]);
      expect(result).toBe('PENDING');
    });

    it('should prioritize FAILURE over PENDING when both exist', () => {
      const result = githubCLIService.computeCIStatus([
        { status: 'COMPLETED', conclusion: 'FAILURE' },
        { status: 'IN_PROGRESS' },
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
      ]);
      expect(result).toBe('FAILURE');
    });

    it('should return FAILURE when all checks are CANCELLED', () => {
      const result = githubCLIService.computeCIStatus([
        { status: 'COMPLETED', conclusion: 'CANCELLED' },
        { status: 'COMPLETED', conclusion: 'CANCELLED' },
      ]);
      expect(result).toBe('FAILURE');
    });

    it('should return FAILURE for mixed SUCCESS/SKIPPED/NEUTRAL/CANCELLED checks', () => {
      const result = githubCLIService.computeCIStatus([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'SKIPPED' },
        { status: 'COMPLETED', conclusion: 'NEUTRAL' },
        { status: 'COMPLETED', conclusion: 'CANCELLED' },
      ]);
      expect(result).toBe('FAILURE');
    });

    it('should prefer the latest run attempt for the same check identity', () => {
      const result = githubCLIService.computeCIStatus([
        {
          name: 'ci',
          workflowName: 'CI',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.com/org/repo/actions/runs/100/job/1',
        },
        {
          name: 'ci',
          workflowName: 'CI',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          detailsUrl: 'https://github.com/org/repo/actions/runs/101/job/1',
        },
      ]);
      expect(result).toBe('SUCCESS');
    });

    it('should return FAILURE for lowercase completed + failure values', () => {
      const result = githubCLIService.computeCIStatus([
        { status: 'completed', conclusion: 'failure' },
      ]);
      expect(result).toBe('FAILURE');
    });

    it('should return PENDING when status is QUEUED even if conclusion is set', () => {
      const result = githubCLIService.computeCIStatus([
        { status: 'QUEUED', conclusion: 'SUCCESS' },
      ]);
      expect(result).toBe('PENDING');
    });

    it('should use legacy state field when status is missing', () => {
      const result = githubCLIService.computeCIStatus([{ state: 'SUCCESS' }]);
      expect(result).toBe('SUCCESS');
    });

    it('should default to PENDING when no status or state fields are present', () => {
      const result = githubCLIService.computeCIStatus([{}]);
      expect(result).toBe('PENDING');
    });

    it('should return UNKNOWN for unrecognized non-pending non-failure states', () => {
      const result = githubCLIService.computeCIStatus([
        { status: 'COMPLETED', conclusion: 'STALE' },
      ]);
      // STALE is not SUCCESS/SKIPPED, nor FAILURE/ERROR/ACTION_REQUIRED
      // So allSuccess check will fail, returning UNKNOWN
      expect(result).toBe('UNKNOWN');
    });

    it('matches shared core classification for mixed check-rollup payloads', () => {
      const cases = [
        [{ status: 'COMPLETED', conclusion: 'FAILURE' }],
        [{ state: 'ERROR' }],
        [{ status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' }],
        [{ status: 'IN_PROGRESS' }],
        [{ state: 'EXPECTED' }],
        [{ status: 'COMPLETED', conclusion: 'NEUTRAL' }],
        [{ status: 'COMPLETED', conclusion: 'CANCELLED' }],
        [
          { status: 'COMPLETED', conclusion: 'SUCCESS' },
          { status: 'COMPLETED', conclusion: 'FAILURE' },
          { status: 'IN_PROGRESS' },
        ],
      ];

      for (const checks of cases) {
        expect(githubCLIService.computeCIStatus(checks)).toBe(
          deriveCiStatusFromCheckRollup(checks)
        );
      }
    });
  });

  describe('computePRState edge cases', () => {
    it('should return MERGED when state is MERGED', () => {
      const status = {
        number: 1,
        state: 'MERGED' as const,
        isDraft: false,
        reviewDecision: null,
        statusCheckRollup: null,
      };
      expect(githubCLIService.computePRState(status)).toBe('MERGED');
    });

    it('should return OPEN when reviewDecision is REVIEW_REQUIRED', () => {
      const status = {
        number: 1,
        state: 'OPEN' as const,
        isDraft: false,
        reviewDecision: 'REVIEW_REQUIRED' as const,
        statusCheckRollup: null,
      };
      expect(githubCLIService.computePRState(status)).toBe('OPEN');
    });

    it('should return DRAFT even when reviewDecision is APPROVED', () => {
      const status = {
        number: 1,
        state: 'OPEN' as const,
        isDraft: true,
        reviewDecision: 'APPROVED' as const,
        statusCheckRollup: null,
      };
      // Draft takes priority over review decision
      expect(githubCLIService.computePRState(status)).toBe('DRAFT');
    });
  });

  describe('getPRStatus rate limit handling', () => {
    it('should re-throw rate limit errors for caller backoff', async () => {
      const rateLimitError = new Error('HTTP 429 rate limit exceeded');
      mockExecFile.mockRejectedValue(rateLimitError);

      await expect(
        githubCLIService.getPRStatus('https://github.com/owner/repo/pull/123')
      ).rejects.toThrow('HTTP 429 rate limit exceeded');
    });
  });

  describe('reviewDecision schema edge cases', () => {
    it('should normalize empty string reviewDecision to null', async () => {
      const prData = {
        number: 42,
        state: 'OPEN',
        isDraft: false,
        reviewDecision: '',
        statusCheckRollup: null,
      };

      mockExecFile.mockResolvedValue({
        stdout: JSON.stringify(prData),
        stderr: '',
      });

      const result = await githubCLIService.getPRStatus('https://github.com/owner/repo/pull/42');
      expect(result?.reviewDecision).toBeNull();
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

    it('throws when the gh CLI call fails', async () => {
      mockExecFile.mockRejectedValue(new Error('network down'));

      await expect(githubCLIService.getResolvedReviewCommentIds('owner/repo', 123)).rejects.toThrow(
        'Failed to fetch resolved review threads: network down'
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
    it('fetches and computes PR state summary', async () => {
      const getStatusSpy = vi.spyOn(githubCLIService, 'getPRStatus').mockResolvedValue({
        number: 77,
        state: 'OPEN',
        isDraft: false,
        reviewDecision: 'REVIEW_REQUIRED',
        statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
      });

      const result = await githubCLIService.fetchAndComputePRState(
        'https://github.com/o/r/pull/77'
      );

      expect(result).toEqual({
        prState: 'OPEN',
        prNumber: 77,
        prReviewState: 'REVIEW_REQUIRED',
        prCiStatus: 'SUCCESS',
        headRefName: null,
      });

      getStatusSpy.mockRestore();
    });

    it('returns null from fetchAndComputePRState when PR cannot be fetched', async () => {
      const getStatusSpy = vi.spyOn(githubCLIService, 'getPRStatus').mockResolvedValue(null);
      await expect(
        githubCLIService.fetchAndComputePRState('https://github.com/o/r/pull/99')
      ).resolves.toBeNull();
      getStatusSpy.mockRestore();
    });

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

    it('approves PR and logs failures with contextual error', async () => {
      mockExecFile.mockResolvedValueOnce({ stdout: '', stderr: '' });
      await expect(githubCLIService.approvePR('o', 'r', 22)).resolves.toBeUndefined();

      mockExecFile.mockRejectedValueOnce(new Error('approval denied'));
      await expect(githubCLIService.approvePR('o', 'r', 22)).rejects.toThrow(
        'Failed to approve PR: approval denied'
      );
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

      mockExecFile.mockRejectedValueOnce(new Error('issue list failed'));
      await expect(githubCLIService.listIssues('o', 'r')).rejects.toThrow(
        'Failed to list issues: issue list failed'
      );
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

    it('gets and closes issues with success and error branches', async () => {
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

      mockExecFile.mockResolvedValueOnce({ stdout: '', stderr: '' });
      await expect(githubCLIService.closeIssue('o', 'r', 7)).resolves.toBeUndefined();

      mockExecFile.mockRejectedValueOnce(new Error('issue close failed'));
      await expect(githubCLIService.closeIssue('o', 'r', 7)).rejects.toThrow(
        'Failed to close issue: issue close failed'
      );
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

    it('passes abort signals to PR detail child processes', async () => {
      const controller = new AbortController();
      mockExecFile.mockResolvedValue({
        stdout: JSON.stringify({
          number: 42,
          title: 'PR',
          url: 'https://github.com/owner/repo/pull/42',
          author: { login: 'author' },
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          isDraft: false,
          state: 'OPEN',
          reviewDecision: null,
          statusCheckRollup: [],
          reviews: [],
          comments: [],
          labels: [],
          additions: 0,
          deletions: 0,
          changedFiles: 0,
          headRefName: 'feature',
          baseRefName: 'main',
          mergeStateStatus: 'CLEAN',
        }),
        stderr: '',
      });

      await githubCLIService.getPRFullDetails('owner/repo', 42, controller.signal);

      expect(mockExecFile).toHaveBeenCalledWith(
        'gh',
        expect.any(Array),
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

    it('does not singleflight identical signal-bound PR reads', async () => {
      const first = new AbortController();
      const second = new AbortController();
      const prDetails = {
        number: 42,
        title: 'PR',
        url: 'https://github.com/owner/repo/pull/42',
        author: { login: 'author' },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        isDraft: false,
        state: 'OPEN',
        reviewDecision: null,
        statusCheckRollup: [],
        reviews: [],
        comments: [],
        labels: [],
        additions: 0,
        deletions: 0,
        changedFiles: 0,
        headRefName: 'feature',
        baseRefName: 'main',
        mergeStateStatus: 'CLEAN',
      };
      mockExecFile.mockResolvedValue({ stdout: JSON.stringify(prDetails), stderr: '' });

      await Promise.all([
        githubCLIService.getPRFullDetails('owner/repo', 42, first.signal),
        githubCLIService.getPRFullDetails('owner/repo', 42, second.signal),
      ]);

      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    it('does not spawn a signal-bound read that is cancelled while queued', async () => {
      const prDetails = {
        number: 42,
        title: 'PR',
        url: 'https://github.com/owner/repo/pull/42',
        author: { login: 'author' },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        isDraft: false,
        state: 'OPEN',
        reviewDecision: null,
        statusCheckRollup: [],
        reviews: [],
        comments: [],
        labels: [],
        additions: 0,
        deletions: 0,
        changedFiles: 0,
        headRefName: 'feature',
        baseRefName: 'main',
        mergeStateStatus: 'CLEAN',
      };
      const releases: Array<() => void> = [];
      mockExecFile.mockImplementation(
        () =>
          new Promise((resolve) => {
            releases.push(() => resolve({ stdout: JSON.stringify(prDetails), stderr: '' }));
          })
      );

      const blockers = Array.from({ length: 5 }, (_, index) => {
        const controller = new AbortController();
        return githubCLIService.getPRFullDetails('owner/repo', index + 1, controller.signal);
      });
      await vi.waitFor(() => expect(mockExecFile).toHaveBeenCalledTimes(5));

      const queuedController = new AbortController();
      const abortReason = new Error('queued request cancelled');
      const queued = githubCLIService.getPRFullDetails('owner/repo', 99, queuedController.signal);
      queuedController.abort(abortReason);
      releases.shift()?.();

      await expect(queued).rejects.toBe(abortReason);
      expect(mockExecFile).toHaveBeenCalledTimes(5);

      for (const release of releases) {
        release();
      }
      await Promise.all(blockers);
    });

    it('deduplicates identical concurrent read calls', async () => {
      const mockPRData = {
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
        githubCLIService.getPRStatus('https://github.com/owner/repo/pull/42'),
        githubCLIService.getPRStatus('https://github.com/owner/repo/pull/42'),
      ]);

      // Both should succeed with same data
      expect(result1).toEqual(mockPRData);
      expect(result2).toEqual(mockPRData);

      // But execFile should only have been called once (singleflight)
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it('does not deduplicate calls with different args', async () => {
      const makePRData = (num: number) => ({
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
        githubCLIService.getPRStatus('https://github.com/owner/repo/pull/1'),
        githubCLIService.getPRStatus('https://github.com/owner/repo/pull/2'),
      ]);

      expect(result1?.number).toBe(1);
      expect(result2?.number).toBe(2);
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    it('removes inflight entry after resolution so subsequent calls spawn new process', async () => {
      const mockPRData = {
        number: 10,
        state: 'OPEN',
        isDraft: false,
        reviewDecision: null,
        statusCheckRollup: [],
      };

      mockExecFile.mockResolvedValue({ stdout: JSON.stringify(mockPRData), stderr: '' });

      // First call
      await githubCLIService.getPRStatus('https://github.com/owner/repo/pull/10');
      // Second call (sequential, not concurrent)
      await githubCLIService.getPRStatus('https://github.com/owner/repo/pull/10');

      // Each sequential call should spawn its own process
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    it('shares rejection across deduplicated callers', async () => {
      mockExecFile.mockRejectedValue(new Error('some unexpected error'));

      const [result1, result2] = await Promise.all([
        githubCLIService.getPRStatus('https://github.com/owner/repo/pull/99'),
        githubCLIService.getPRStatus('https://github.com/owner/repo/pull/99'),
      ]);

      // Both should get null (getPRStatus catches and returns null)
      expect(result1).toBeNull();
      expect(result2).toBeNull();

      // Only one process should have been spawned
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('centralized exec - mutating calls', () => {
    it('does not deduplicate mutating calls with same args', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

      await Promise.all([
        githubCLIService.closeIssue('owner', 'repo', 5),
        githubCLIService.closeIssue('owner', 'repo', 5),
      ]);

      // Both calls should spawn separate processes (no dedup for writes)
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('error classification - unexpected EOF', () => {
    it('classifies unexpected EOF as network_error, not unknown', async () => {
      mockExecFile.mockRejectedValue(
        new Error(
          'Command failed: gh pr view 1364 --repo owner/repo\nPost "https://api.github.com/graphql": unexpected EOF\n'
        )
      );

      const result = await githubCLIService.getPRStatus('https://github.com/owner/repo/pull/1364');

      expect(result).toBeNull();
      // Should NOT log as "Failed to fetch PR status via gh CLI" (unknown)
      // Should log as network_error which still goes through the unknown/else branch but with correct type
      expect(mockLoggerError).toHaveBeenCalledWith(
        'Failed to fetch PR status via gh CLI',
        expect.objectContaining({
          errorType: 'network_error',
        })
      );
    });
  });
});
