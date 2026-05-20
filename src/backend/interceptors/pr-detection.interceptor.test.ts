import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InterceptorContext, ToolEvent } from './types';

const mockAttachAndRefreshPR = vi.fn();

vi.mock('@/backend/services/github', () => ({
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

  it('detects PR URL from GitHub MCP create_pull_request results', async () => {
    const event = createEvent({
      toolName: 'mcpToolCall:codex_apps/github_create_pull_request',
      input: {
        type: 'mcpToolCall',
        id: 'call_oensfoBCcJ33zeogkYFUkfw4',
        server: 'codex_apps',
        tool: 'github_create_pull_request',
        arguments: {
          repository_full_name: 'purplefish-ai/factory-factory',
          base_branch: 'main',
          head_branch: 'fix-npm-publish-release-version-output',
          title: 'Fix npm publish release version output',
        },
      },
      output: {
        content: JSON.stringify({
          type: 'mcpToolCall',
          id: 'call_oensfoBCcJ33zeogkYFUkfw4',
          server: 'codex_apps',
          tool: 'github_create_pull_request',
          status: 'completed',
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  url: 'https://github.com/purplefish-ai/factory-factory/pull/1581',
                  number: 1581,
                  state: 'open',
                  display_url: 'https://github.com/purplefish-ai/factory-factory/pull/1581',
                }),
              },
            ],
            structuredContent: {
              url: 'https://github.com/purplefish-ai/factory-factory/pull/1581',
              number: 1581,
            },
          },
        }),
        isError: false,
      },
    });

    await prDetectionInterceptor.onToolComplete!(event, context);

    expect(mockAttachAndRefreshPR).toHaveBeenCalledWith(
      'workspace-1',
      'https://github.com/purplefish-ai/factory-factory/pull/1581'
    );
  });

  it('detects PR URL from GitHub MCP create_pull_request display tool names', async () => {
    const event = createEvent({
      toolName: 'mcpToolCall:github/create_pull_request',
      input: {},
      output: {
        content: JSON.stringify({
          structuredContent: {
            url: 'https://github.com/purplefish-ai/factory-factory/pull/1582',
          },
        }),
        isError: false,
      },
    });

    await prDetectionInterceptor.onToolComplete!(event, context);

    expect(mockAttachAndRefreshPR).toHaveBeenCalledWith(
      'workspace-1',
      'https://github.com/purplefish-ai/factory-factory/pull/1582'
    );
  });

  it('detects PR URL from codex_apps MCP create_pull_request display tool names', async () => {
    const event = createEvent({
      toolName: 'mcpToolCall:codex_apps/create_pull_request',
      input: {},
      output: {
        content: JSON.stringify({
          structuredContent: {
            url: 'https://github.com/purplefish-ai/factory-factory/pull/1584',
          },
        }),
        isError: false,
      },
    });

    await prDetectionInterceptor.onToolComplete!(event, context);

    expect(mockAttachAndRefreshPR).toHaveBeenCalledWith(
      'workspace-1',
      'https://github.com/purplefish-ai/factory-factory/pull/1584'
    );
  });

  it('detects PR URL from codex_apps MCP create_pull_request input fields', async () => {
    const event = createEvent({
      toolName: 'mcpToolCall',
      input: {
        type: 'mcpToolCall',
        server: 'codex_apps',
        tool: 'create_pull_request',
      },
      output: {
        content: JSON.stringify({
          structuredContent: {
            url: 'https://github.com/purplefish-ai/factory-factory/pull/1585',
          },
        }),
        isError: false,
      },
    });

    await prDetectionInterceptor.onToolComplete!(event, context);

    expect(mockAttachAndRefreshPR).toHaveBeenCalledWith(
      'workspace-1',
      'https://github.com/purplefish-ai/factory-factory/pull/1585'
    );
  });

  it('does not detect create_pull_request from custom servers containing github', async () => {
    const event = createEvent({
      toolName: 'mcpToolCall:company_github/create_pull_request',
      input: {
        type: 'mcpToolCall',
        server: 'company_github',
        tool: 'create_pull_request',
      },
      output: {
        content: JSON.stringify({
          structuredContent: {
            url: 'https://github.com/purplefish-ai/factory-factory/pull/1586',
          },
        }),
        isError: false,
      },
    });

    await prDetectionInterceptor.onToolComplete!(event, context);

    expect(mockAttachAndRefreshPR).not.toHaveBeenCalled();
  });

  it('does not detect create_pull_request from display servers containing github', async () => {
    const event = createEvent({
      toolName: 'mcpToolCall:x_github/create_pull_request',
      input: {},
      output: {
        content: JSON.stringify({
          structuredContent: {
            url: 'https://github.com/purplefish-ai/factory-factory/pull/1587',
          },
        }),
        isError: false,
      },
    });

    await prDetectionInterceptor.onToolComplete!(event, context);

    expect(mockAttachAndRefreshPR).not.toHaveBeenCalled();
  });

  it('does not detect unrelated tool names ending in github_create_pull_request', async () => {
    const event = createEvent({
      toolName: 'company_github_create_pull_request',
      input: {},
      output: {
        content: JSON.stringify({
          structuredContent: {
            url: 'https://github.com/purplefish-ai/factory-factory/pull/1588',
          },
        }),
        isError: false,
      },
    });

    await prDetectionInterceptor.onToolComplete!(event, context);

    expect(mockAttachAndRefreshPR).not.toHaveBeenCalled();
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

  it('associates PR when gh pr create exits with error but output contains URL (PR already exists)', async () => {
    const event = createEvent({
      toolName: 'Bash',
      input: { command: 'gh pr create --title "test"' },
      output: {
        content:
          "GraphQL: A pull request for branch 'feature-x' into branch 'main' already exists:\nhttps://github.com/purplefish-ai/factory-factory/pull/1001\n(createPullRequest)",
        isError: true,
      },
    });

    await prDetectionInterceptor.onToolComplete!(event, context);

    expect(mockAttachAndRefreshPR).toHaveBeenCalledWith(
      'workspace-1',
      'https://github.com/purplefish-ai/factory-factory/pull/1001'
    );
  });

  it('does not call attachAndRefreshPR when gh pr create fails with no PR URL in output', async () => {
    const event = createEvent({
      toolName: 'Bash',
      input: { command: 'gh pr create --title "test"' },
      output: {
        content: 'error: remote: Repository not found.',
        isError: true,
      },
    });

    await prDetectionInterceptor.onToolComplete!(event, context);

    expect(mockAttachAndRefreshPR).not.toHaveBeenCalled();
  });

  it('does not attach arbitrary PR URLs from non-create MCP tools', async () => {
    const event = createEvent({
      toolName: 'mcpToolCall:codex_apps/github_fetch_pull_request',
      input: {
        type: 'mcpToolCall',
        server: 'codex_apps',
        tool: 'github_fetch_pull_request',
      },
      output: {
        content: JSON.stringify({
          structuredContent: {
            url: 'https://github.com/purplefish-ai/factory-factory/pull/1583',
          },
        }),
        isError: false,
      },
    });

    await prDetectionInterceptor.onToolComplete!(event, context);

    expect(mockAttachAndRefreshPR).not.toHaveBeenCalled();
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
