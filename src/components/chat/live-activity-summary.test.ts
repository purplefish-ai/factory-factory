import { describe, expect, it } from 'vitest';
import type { GroupedMessageItem, PairedToolCall } from '@/lib/chat-protocol';
import { summarizeLiveActivity, toThinkingSnippet } from './live-activity-summary';
import type { PendingRequest, ToolProgressInfo } from './reducer/types';

function createCall(overrides: Partial<PairedToolCall>): PairedToolCall {
  return {
    id: 'call-1',
    name: 'Edit',
    input: {},
    status: 'pending',
    ...overrides,
  };
}

function createPendingRequest(type: PendingRequest['type']): PendingRequest {
  if (type === 'permission') {
    return {
      type: 'permission',
      request: {
        requestId: 'perm-1',
        toolName: 'Edit',
        toolInput: { file_path: 'src/app.ts' },
        timestamp: new Date().toISOString(),
      },
    };
  }

  if (type === 'question') {
    return {
      type: 'question',
      request: {
        requestId: 'question-1',
        questions: [
          {
            question: 'Continue?',
            options: [
              { label: 'yes', description: 'Continue' },
              { label: 'no', description: 'Stop' },
            ],
          },
        ],
        timestamp: new Date().toISOString(),
      },
    };
  }

  return { type: 'none' };
}

describe('live-activity-summary', () => {
  describe('toThinkingSnippet', () => {
    it('returns only the latest non-empty thinking line', () => {
      const snippet = toThinkingSnippet(
        `\n**Planning repo inspection**\n\n**Tracing runtime state**\n`
      );
      expect(snippet).toBe('Tracing runtime state');
    });

    it('returns null for empty thinking content', () => {
      expect(toThinkingSnippet('   \n\n')).toBeNull();
    });
  });

  it('prioritizes pending approval in now state', () => {
    const summary = summarizeLiveActivity({
      groupedMessages: [],
      latestThinking: null,
      running: true,
      starting: false,
      stopping: false,
      pendingRequest: createPendingRequest('permission'),
      permissionMode: null,
      toolProgress: new Map(),
    });

    expect(summary.now.label).toBe('Waiting for approval: Edit');
    expect(summary.needsAttention?.kind).toBe('permission');
  });

  it('builds recent milestones and test outcomes from tool calls', () => {
    const groupedMessages: GroupedMessageItem[] = [
      {
        type: 'tool_sequence',
        id: 'seq-1',
        pairedCalls: [
          createCall({
            id: 'call-edit',
            name: 'Edit',
            input: { file_path: 'src/backend/session.service.ts' },
            status: 'success',
            result: { content: 'applied', isError: false },
          }),
          createCall({
            id: 'call-test',
            name: 'Run pnpm test',
            input: { command: ['pnpm', 'test'] },
            status: 'success',
            result: { content: '12 passed, 0 failed', isError: false },
          }),
        ],
      },
    ];

    const summary = summarizeLiveActivity({
      groupedMessages,
      latestThinking: null,
      running: false,
      starting: false,
      stopping: false,
      pendingRequest: createPendingRequest('none'),
      permissionMode: null,
      toolProgress: new Map(),
    });

    expect(summary.recent.map((event) => event.label)).toEqual([
      'Tests passed',
      'Completed Run pnpm test',
      'Started Run pnpm test',
    ]);
    expect(summary.filesTouched.map((file) => file.path)).toContain(
      'src/backend/session.service.ts'
    );
  });

  it('marks tests as failed when output contains failure text despite success status', () => {
    const groupedMessages: GroupedMessageItem[] = [
      {
        type: 'tool_sequence',
        id: 'seq-1',
        pairedCalls: [
          createCall({
            id: 'call-test',
            name: 'Run pnpm test',
            input: { command: ['pnpm', 'test'] },
            status: 'success',
            result: { content: '12 passed, 1 failed', isError: false },
          }),
        ],
      },
    ];

    const summary = summarizeLiveActivity({
      groupedMessages,
      latestThinking: null,
      running: false,
      starting: false,
      stopping: false,
      pendingRequest: createPendingRequest('none'),
      permissionMode: null,
      toolProgress: new Map(),
    });

    expect(summary.recent.map((event) => event.label)).toContain('Tests failed');
  });

  it('deduplicates touched files and caps to six visible chips', () => {
    const toolProgress = new Map<string, ToolProgressInfo>();
    toolProgress.set('tool-1', {
      toolName: 'Edit',
      elapsedSeconds: 1,
      acpLocations: [
        { path: 'src/a.ts', line: 1 },
        { path: 'src/b.ts', line: 1 },
        { path: 'src/c.ts', line: 1 },
        { path: 'src/d.ts', line: 1 },
        { path: 'src/e.ts', line: 1 },
        { path: 'src/f.ts', line: 1 },
        { path: 'src/g.ts', line: 1 },
        { path: 'src/a.ts', line: 2 },
      ],
    });

    const summary = summarizeLiveActivity({
      groupedMessages: [],
      latestThinking: null,
      running: true,
      starting: false,
      stopping: false,
      pendingRequest: createPendingRequest('none'),
      permissionMode: null,
      toolProgress,
    });

    expect(summary.filesTouched).toHaveLength(6);
    expect(summary.hiddenFileCount).toBe(1);
    expect(summary.filesTouched[summary.filesTouched.length - 1]).toEqual({
      path: 'src/a.ts',
      line: 2,
    });
  });
});
