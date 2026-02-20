import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSetBranchName = vi.hoisted(() => vi.fn());
const mockGitCommand = vi.hoisted(() => vi.fn());
const mockExtractInputValue = vi.hoisted(() => vi.fn());

vi.mock('@/backend/domains/workspace', () => ({
  workspaceDataService: {
    setBranchName: (...args: unknown[]) => mockSetBranchName(...args),
  },
}));

vi.mock('@/backend/lib/shell', () => ({
  gitCommand: (...args: unknown[]) => mockGitCommand(...args),
}));

vi.mock('@/backend/schemas/tool-inputs.schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backend/schemas/tool-inputs.schema')>();
  return {
    ...actual,
    extractInputValue: (...args: unknown[]) => mockExtractInputValue(...args),
  };
});

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { branchRenameInterceptor } from './branch-rename.interceptor';

describe('branchRenameInterceptor', () => {
  const context = {
    workspaceId: 'w1',
    workingDir: '/tmp/w1',
  } as never;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ignores errored tool events and non-rename commands', async () => {
    await branchRenameInterceptor.onToolComplete!(
      {
        toolName: 'Bash',
        output: { isError: true },
      } as never,
      context
    );

    mockExtractInputValue.mockReturnValue('git status');
    await branchRenameInterceptor.onToolComplete!(
      {
        toolName: 'Bash',
        output: { isError: false },
        input: {},
      } as never,
      context
    );

    expect(mockGitCommand).not.toHaveBeenCalled();
    expect(mockSetBranchName).not.toHaveBeenCalled();
  });

  it('updates workspace branch name after git branch -m', async () => {
    mockExtractInputValue.mockReturnValue('git branch -m better-name');
    mockGitCommand.mockResolvedValue({ code: 0, stdout: 'new-branch\n', stderr: '' });

    await branchRenameInterceptor.onToolComplete!(
      {
        toolName: 'Bash',
        output: { isError: false },
        input: {},
      } as never,
      context
    );

    expect(mockGitCommand).toHaveBeenCalledWith(['rev-parse', '--abbrev-ref', 'HEAD'], '/tmp/w1');
    expect(mockSetBranchName).toHaveBeenCalledWith('w1', 'new-branch');
  });

  it('skips updates when branch lookup fails or returns empty branch', async () => {
    mockExtractInputValue.mockReturnValue('git branch -M force-name');
    mockGitCommand.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'failed' });

    await branchRenameInterceptor.onToolComplete!(
      {
        toolName: 'Bash',
        output: { isError: false },
        input: {},
      } as never,
      context
    );

    mockGitCommand.mockResolvedValueOnce({ code: 0, stdout: '   \n', stderr: '' });
    await branchRenameInterceptor.onToolComplete!(
      {
        toolName: 'Bash',
        output: { isError: false },
        input: {},
      } as never,
      context
    );

    expect(mockSetBranchName).not.toHaveBeenCalled();
  });
});
