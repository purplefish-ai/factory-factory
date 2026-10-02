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

describe('PR detail review fetch coordination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    githubCLIService.clearCaches();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes abort signals to PR detail child processes', async () => {
    const controller = new AbortController();
    mockExecFile.mockResolvedValueOnce({
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

    mockExecFile.mockResolvedValueOnce({ stdout: '[[]]', stderr: '' });
    await githubCLIService.getPRFullDetails('owner/repo', 42, controller.signal);

    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['api', 'repos/owner/repo/pulls/42/reviews?per_page=100', '--paginate', '--slurp'],
      expect.objectContaining({ signal: controller.signal, maxBuffer: 10 * 1024 * 1024 })
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
    mockExecFile.mockImplementation((_command, args: string[]) =>
      Promise.resolve({
        stdout: args[0] === 'api' ? '[[]]' : JSON.stringify(prDetails),
        stderr: '',
      })
    );

    await Promise.all([
      githubCLIService.getPRFullDetails('owner/repo', 42, first.signal),
      githubCLIService.getPRFullDetails('owner/repo', 42, second.signal),
    ]);

    expect(mockExecFile).toHaveBeenCalledTimes(4);
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
    mockExecFile.mockImplementation((_command, args: string[]) =>
      args[0] === 'api'
        ? Promise.resolve({ stdout: '[[]]', stderr: '' })
        : new Promise((resolve) => {
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
    expect(mockExecFile.mock.calls.filter(([, args]) => args[0] === 'pr')).toHaveLength(5);

    for (const release of releases) {
      release();
    }
    await Promise.all(blockers);
  });
});
