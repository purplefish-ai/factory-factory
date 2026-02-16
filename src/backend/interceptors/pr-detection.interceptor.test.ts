import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InterceptorContext, ToolEvent } from './types';

const mockAttachAndRefreshPR = vi.fn();

vi.mock('@/backend/domains/github', () => ({
  prSnapshotService: {
    attachAndRefreshPR: (...args: unknown[]) => mockAttachAndRefreshPR(...args),
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { prDetectionInterceptor } from './pr-detection.interceptor';

const context: InterceptorContext = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  workingDir: '/tmp/workspace',
  timestamp: new Date('2026-02-15T00:00:00.000Z'),
};

function createEvent(overrides: Partial<ToolEvent>): ToolEvent {
  return {
    toolUseId: 'tool-1',
    toolName: 'Bash',
    input: {},
    ...overrides,
  };
}

describe('prDetectionInterceptor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAttachAndRefreshPR.mockResolvedValue({
      success: true,
      snapshot: {
        prNumber: 123,
        prState: 'OPEN',
        prReviewState: 'PENDING',
        prCiStatus: 'PENDING',
      },
    });
  });

  it('detects PR URL from Bash output', async () => {
    const event = createEvent({
      toolName: 'Bash',
      input: { command: 'gh pr create --title "test"' },
      output: {
        content: 'https://github.com/purplefish-ai/factory-factory/pull/1001\n',
        isError: false,
      },
    });

    await prDetectionInterceptor.onToolComplete!(event, context);

    expect(mockAttachAndRefreshPR).toHaveBeenCalledWith(
      'workspace-1',
      'https://github.com/purplefish-ai/factory-factory/pull/1001'
    );
  });

  it('detects PR URL from Codex commandExecution aggregatedOutput', async () => {
    const event = createEvent({
      toolName: 'commandExecution',
      input: {
        type: 'commandExecution',
        command:
          '/bin/zsh -lc \'gh pr create --base main --head user/branch --title "Fix bug" --body-file /tmp/body.md\'',
        aggregatedOutput: 'https://github.com/purplefish-ai/factory-factory/pull/1037\n',
      },
    });

    await prDetectionInterceptor.onToolComplete!(event, context);

    expect(mockAttachAndRefreshPR).toHaveBeenCalledWith(
      'workspace-1',
      'https://github.com/purplefish-ai/factory-factory/pull/1037'
    );
  });

  it('detects PR URL from nested rawOutput payloads', async () => {
    const event = createEvent({
      toolName: 'execute',
      input: {
        command: 'gh pr create --title "Fix bug"',
        rawOutput: {
          type: 'commandExecution',
          aggregatedOutput: 'https://github.com/purplefish-ai/factory-factory/pull/1038\n',
        },
      },
    });

    await prDetectionInterceptor.onToolComplete!(event, context);

    expect(mockAttachAndRefreshPR).toHaveBeenCalledWith(
      'workspace-1',
      'https://github.com/purplefish-ai/factory-factory/pull/1038'
    );
  });

  it('detects PR URL when command is provided as cmd', async () => {
    const event = createEvent({
      toolName: 'exec_command',
      input: {
        cmd: 'gh pr create --title "Fix bug"',
      },
      output: {
        content: 'https://github.com/purplefish-ai/factory-factory/pull/1047\n',
        isError: false,
      },
    });

    await prDetectionInterceptor.onToolComplete!(event, context);

    expect(mockAttachAndRefreshPR).toHaveBeenCalledWith(
      'workspace-1',
      'https://github.com/purplefish-ai/factory-factory/pull/1047'
    );
  });

  it('falls back to title when command is present but not gh pr create', async () => {
    const event = createEvent({
      toolName: 'commandExecution',
      input: {
        command: 'echo "run wrapper"',
        title: '/bin/zsh -lc \'gh pr create --title "Fix bug" --body-file /tmp/body.md\'',
        aggregatedOutput: 'https://github.com/purplefish-ai/factory-factory/pull/1039\n',
      },
    });

    await prDetectionInterceptor.onToolComplete!(event, context);

    expect(mockAttachAndRefreshPR).toHaveBeenCalledWith(
      'workspace-1',
      'https://github.com/purplefish-ai/factory-factory/pull/1039'
    );
  });

  it('ignores non-create gh commands', async () => {
    const event = createEvent({
      toolName: 'commandExecution',
      input: {
        command: 'gh pr list --state open',
        aggregatedOutput: 'https://github.com/purplefish-ai/factory-factory/pull/9999\n',
      },
    });

    await prDetectionInterceptor.onToolComplete!(event, context);

    expect(mockAttachAndRefreshPR).not.toHaveBeenCalled();
  });
});
