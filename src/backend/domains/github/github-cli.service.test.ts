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
import { githubCLIService } from './github-cli.service';

vi.mocked(execFile).mockImplementation(mockExecFile as never);

describe('GitHubCLIService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        mergedAt: null,
        updatedAt: '2024-01-01T00:00:00Z',
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
        mergedAt: null,
        updatedAt: '2024-01-01T00:00:00Z',
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
        mergedAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
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
        mergedAt: null,
        updatedAt: '2024-01-01T00:00:00Z',
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
        mergedAt: null,
        updatedAt: '2024-01-01T00:00:00Z',
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
        mergedAt: null,
        updatedAt: '2024-01-01T00:00:00Z',
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
        mergedAt: null,
        updatedAt: '2024-01-01T00:00:00Z',
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
        mergedAt: null,
        updatedAt: '2024-01-01T00:00:00Z',
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

    it('should return UNKNOWN when statusCheckRollup is empty', () => {
      const result = githubCLIService.computeCIStatus([]);

      expect(result).toBe('UNKNOWN');
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

    it('should treat NEUTRAL, CANCELLED, and SKIPPED as success', () => {
      const result = githubCLIService.computeCIStatus([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'NEUTRAL' },
        { status: 'COMPLETED', conclusion: 'SKIPPED' },
      ]);

      expect(result).toBe('SUCCESS');
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

    describe('findPRForBranch with malformed data', () => {
      it('should return null and log error when PR list items have wrong structure', async () => {
        const malformedData = [
          {
            number: 123,
            url: 'https://github.com/owner/repo/pull/123',
            // missing state field
          },
        ];

        mockExecFile.mockResolvedValue({
          stdout: JSON.stringify(malformedData),
          stderr: '',
        });

        const result = await githubCLIService.findPRForBranch('owner', 'repo', 'test-branch');

        expect(result).toBeNull();
        expect(mockLoggerError).toHaveBeenCalledWith(
          'Invalid gh CLI JSON response',
          expect.objectContaining({
            context: 'findPRForBranch',
          })
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
      it('should accept StatusContext entries in statusCheckRollup', async () => {
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
              state: 'PENDING',
              targetUrl: 'https://example.com/checks/legacy-status',
            },
            {
              __typename: 'StatusContext',
              context: 'ci/legacy-required',
              state: 'ERROR',
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
});
