import { RequestError } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  SUBAGENTS_CHANGED_METHOD,
  type SubagentTranscriptUpdate,
} from '@/shared/acp-protocol/subagents';
import type { AdapterSession } from './adapter-state';
import { CodexSubagentController } from './codex-subagent-controller';
import type { ThreadReadTurn } from './codex-zod';

function createSession(overrides: Partial<AdapterSession> = {}): AdapterSession {
  return {
    sessionId: 'parent-session-1',
    threadId: 'parent-thread-1',
    cwd: '/tmp/workspace',
    defaults: {
      model: 'gpt-5',
      approvalPolicy: 'on-failure',
      sandboxPolicy: { type: 'workspaceWrite' },
      reasoningEffort: 'medium',
      collaborationMode: 'default',
    },
    activeTurn: null,
    toolCallsByItemId: new Map(),
    syntheticallyCompletedToolItemIds: new Set(),
    reasoningDeltaItemIds: new Set(),
    planTextByItemId: new Map(),
    planApprovalRequestedByTurnId: new Set(),
    pendingPlanApprovalsByTurnId: new Map(),
    pendingTurnCompletionsByTurnId: new Map(),
    commandApprovalScopes: new Set(),
    replayedTurnItemKeys: new Set(),
    ...overrides,
  };
}

function createProjectionSession(parent: AdapterSession, threadId: string): AdapterSession {
  return createSession({
    sessionId: `subagent:${threadId}`,
    threadId,
    cwd: parent.cwd,
    defaults: { ...parent.defaults },
  });
}

describe('CodexSubagentController', () => {
  it('emits one activity invalidation per child and isolates notification failures', async () => {
    const parent = createSession();
    const extNotification = vi.fn(() => Promise.reject(new Error('connection closed')));
    const controller = new CodexSubagentController({
      codex: { request: vi.fn() },
      requireSession: () => parent,
      createProjectionSession,
      projectThreadTurns: vi.fn(() => Promise.resolve([])),
      extNotification,
    });

    await expect(
      controller.recordActivity(parent.sessionId, ['child-thread-1', 'child-thread-2'], 'created')
    ).resolves.toBeUndefined();

    expect(extNotification).toHaveBeenCalledTimes(2);
    expect(extNotification).toHaveBeenNthCalledWith(1, SUBAGENTS_CHANGED_METHOD, {
      sessionId: parent.sessionId,
      subagentId: 'child-thread-1',
      change: 'created',
    });
    expect(extNotification).toHaveBeenNthCalledWith(2, SUBAGENTS_CHANGED_METHOD, {
      sessionId: parent.sessionId,
      subagentId: 'child-thread-2',
      change: 'created',
    });
  });

  it('lists only direct children and normalizes terminal summaries', async () => {
    const parent = createSession();
    const extNotification = vi.fn(() => Promise.resolve());
    const longResult = `  ${'x'.repeat(260)}  `;
    const request = vi.fn((method: string) => {
      if (method === 'thread/list') {
        return Promise.resolve({
          data: [
            {
              id: 'child-thread-1',
              parentThreadId: 'parent-thread-1',
              name: null,
              agentNickname: 'security-reviewer',
              preview: 'Audit the authentication flow',
              createdAt: 1_786_147_200,
              updatedAt: 1_786_150_800,
              status: { type: 'idle' },
              turns: [],
              additiveField: true,
            },
            {
              id: 'foreign-thread-1',
              parentThreadId: 'another-parent',
              name: 'foreign',
              preview: 'Must not leak',
              createdAt: 1_786_147_200,
              updatedAt: 1_786_150_800,
              status: { type: 'active', activeFlags: [] },
              turns: [],
            },
          ],
          nextCursor: 'next-list-page',
        });
      }
      if (method === 'thread/read') {
        return Promise.resolve({
          thread: {
            id: 'child-thread-1',
            turns: [
              {
                id: 'child-turn-1',
                status: 'failed',
                startedAt: 1_786_150_700,
                completedAt: 1_786_150_800,
                items: [{ type: 'agentMessage', id: 'answer-1', text: longResult }],
              },
            ],
          },
        });
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const controller = new CodexSubagentController({
      codex: { request },
      requireSession: (sessionId) => {
        if (sessionId !== parent.sessionId) {
          throw RequestError.invalidParams({ sessionId });
        }
        return parent;
      },
      createProjectionSession,
      projectThreadTurns: vi.fn(() => Promise.resolve([])),
      extNotification,
    });

    const result = await controller.list({
      sessionId: 'parent-session-1',
      cursor: null,
      limit: 50,
    });

    expect(request).toHaveBeenCalledWith('thread/list', {
      parentThreadId: 'parent-thread-1',
      cursor: null,
      limit: 50,
      sortKey: 'created_at',
      sortDirection: 'desc',
    });
    expect(result.subagents.map((item) => item.id)).toEqual(['child-thread-1']);
    expect(result).toEqual({
      subagents: [
        {
          id: 'child-thread-1',
          name: 'security-reviewer',
          status: 'failed',
          createdAt: '2026-08-08T00:00:00.000Z',
          updatedAt: '2026-08-08T01:00:00.000Z',
          completedAt: '2026-08-08T01:00:00.000Z',
          latestActivity: 'Audit the authentication flow',
          resultPreview: 'x'.repeat(240),
        },
      ],
      nextCursor: 'next-list-page',
    });

    await controller.handleThreadStatusChanged('child-thread-1', 'systemError');
    expect(extNotification).toHaveBeenCalledWith(SUBAGENTS_CHANGED_METHOD, {
      sessionId: 'parent-session-1',
      subagentId: 'child-thread-1',
      change: 'completed',
    });
  });

  it('maps active provider wait flags to a non-terminal waiting status', async () => {
    const parent = createSession();
    const controller = new CodexSubagentController({
      codex: {
        request: vi.fn((method: string) => {
          if (method === 'thread/list') {
            return Promise.resolve({
              data: [
                {
                  id: 'waiting-child',
                  parentThreadId: parent.threadId,
                  name: 'Waiting for approval',
                  status: { type: 'active', activeFlags: ['waitingOnApproval'] },
                  turns: [],
                },
              ],
              nextCursor: null,
            });
          }
          throw new Error(`unexpected method: ${method}`);
        }),
      },
      requireSession: () => parent,
      createProjectionSession,
      projectThreadTurns: vi.fn(() => Promise.resolve([])),
      extNotification: vi.fn(() => Promise.resolve()),
    });

    await expect(
      controller.list({ sessionId: parent.sessionId, cursor: null, limit: 50 })
    ).resolves.toMatchObject({
      subagents: [{ id: 'waiting-child', status: 'waiting', completedAt: null }],
    });
  });

  it('limits concurrent terminal summary reads to four', async () => {
    const parent = createSession();
    let activeReads = 0;
    let maxActiveReads = 0;
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/list') {
        return Promise.resolve({
          data: Array.from({ length: 6 }, (_, index) => ({
            id: `child-thread-${index}`,
            parentThreadId: parent.threadId,
            name: null,
            preview: `Child ${index}`,
            createdAt: 1_786_147_200 + index,
            updatedAt: 1_786_150_800 + index,
            status: { type: 'idle' },
            turns: [],
          })),
          nextCursor: null,
        });
      }
      if (method === 'thread/read') {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeReads -= 1;
        return Promise.resolve({
          thread: {
            id: params.threadId,
            turns: [
              {
                id: `turn-${params.threadId}`,
                status: 'completed',
                completedAt: 1_786_150_800,
                items: [],
              },
            ],
          },
        });
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const controller = new CodexSubagentController({
      codex: { request },
      requireSession: () => parent,
      createProjectionSession,
      projectThreadTurns: vi.fn(() => Promise.resolve([])),
      extNotification: vi.fn(() => Promise.resolve()),
    });

    await controller.list({ sessionId: parent.sessionId, cursor: null, limit: 50 });

    expect(maxActiveReads).toBe(4);
  });

  it('keeps terminal summaries when one transcript enrichment fails', async () => {
    const parent = createSession();
    const request = vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === 'thread/list') {
        return Promise.resolve({
          data: [
            {
              id: 'missing-child',
              parentThreadId: parent.threadId,
              name: 'Missing transcript',
              preview: 'Last known activity',
              status: { type: 'idle' },
              turns: [],
            },
            {
              id: 'healthy-child',
              parentThreadId: parent.threadId,
              name: 'Healthy transcript',
              preview: 'Finished normally',
              status: { type: 'idle' },
              turns: [],
            },
          ],
          nextCursor: null,
        });
      }
      if (method === 'thread/read' && params.threadId === 'missing-child') {
        return Promise.reject(new Error('provider log expired'));
      }
      if (method === 'thread/read' && params.threadId === 'healthy-child') {
        return Promise.resolve({
          thread: {
            id: 'healthy-child',
            turns: [
              {
                id: 'healthy-turn',
                status: 'completed',
                completedAt: 1_786_150_800,
                items: [{ type: 'agentMessage', id: 'answer', text: 'Healthy result' }],
              },
            ],
          },
        });
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const controller = new CodexSubagentController({
      codex: { request },
      requireSession: () => parent,
      createProjectionSession,
      projectThreadTurns: vi.fn(() => Promise.resolve([])),
      extNotification: vi.fn(() => Promise.resolve()),
    });

    await expect(
      controller.list({ sessionId: parent.sessionId, cursor: null, limit: 50 })
    ).resolves.toMatchObject({
      subagents: [
        {
          id: 'missing-child',
          status: 'completed',
          latestActivity: 'Last known activity',
          completedAt: null,
          resultPreview: null,
        },
        {
          id: 'healthy-child',
          status: 'completed',
          resultPreview: 'Healthy result',
        },
      ],
    });
  });

  it('does not enrich a summary from a mismatched thread response', async () => {
    const parent = createSession();
    const request = vi.fn((method: string) => {
      if (method === 'thread/list') {
        return Promise.resolve({
          data: [
            {
              id: 'requested-child',
              parentThreadId: parent.threadId,
              name: 'Requested child',
              preview: 'Last known activity',
              status: { type: 'idle' },
              turns: [],
            },
          ],
          nextCursor: null,
        });
      }
      if (method === 'thread/read') {
        return Promise.resolve({
          thread: {
            id: 'different-child',
            turns: [
              {
                id: 'foreign-turn',
                status: 'completed',
                items: [{ type: 'agentMessage', id: 'foreign-answer', text: 'Do not expose me' }],
              },
            ],
          },
        });
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const controller = new CodexSubagentController({
      codex: { request },
      requireSession: () => parent,
      createProjectionSession,
      projectThreadTurns: vi.fn(() => Promise.resolve([])),
      extNotification: vi.fn(() => Promise.resolve()),
    });

    await expect(
      controller.list({ sessionId: parent.sessionId, cursor: null, limit: 50 })
    ).resolves.toMatchObject({
      subagents: [{ id: 'requested-child', resultPreview: null, completedAt: null }],
    });
  });

  it('normalizes an unknown terminal turn status and reports shape drift', async () => {
    const parent = createSession();
    const reportShapeDrift = vi.fn();
    const controller = new CodexSubagentController({
      codex: {
        request: vi.fn(() =>
          Promise.resolve({
            data: [
              {
                id: 'future-status-child',
                parentThreadId: parent.threadId,
                status: { type: 'idle' },
                turns: [
                  {
                    id: 'future-turn',
                    status: 'supersededByProvider',
                    items: [],
                  },
                ],
              },
            ],
            nextCursor: null,
          })
        ),
      },
      requireSession: () => parent,
      createProjectionSession,
      projectThreadTurns: vi.fn(() => Promise.resolve([])),
      extNotification: vi.fn(() => Promise.resolve()),
      reportShapeDrift,
    });

    await expect(
      controller.list({ sessionId: parent.sessionId, cursor: null, limit: 50 })
    ).resolves.toMatchObject({
      subagents: [{ id: 'future-status-child', status: 'completed' }],
    });
    expect(reportShapeDrift).toHaveBeenCalledWith('unknown_subagent_turn_status', {
      status: 'supersededByProvider',
    });
  });

  it('includes the live turn only on the newest page while paging completed turns', async () => {
    const parent = createSession();
    const projectedTurnPages: string[][] = [];
    const request = vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === 'thread/list') {
        return Promise.resolve({
          data: [
            {
              id: 'child-thread-1',
              parentThreadId: parent.threadId,
              preview: 'First child',
              status: { type: 'active', activeFlags: [] },
              turns: [],
            },
            {
              id: 'child-thread-2',
              parentThreadId: parent.threadId,
              preview: 'Second child',
              status: { type: 'active', activeFlags: [] },
              turns: [],
            },
            {
              id: 'foreign-thread-1',
              parentThreadId: 'foreign-parent',
              preview: 'Foreign child',
              status: { type: 'active', activeFlags: [] },
              turns: [],
            },
          ],
          nextCursor: null,
        });
      }
      if (method === 'thread/read' && params.threadId === 'child-thread-1') {
        return Promise.resolve({
          thread: {
            id: 'child-thread-1',
            turns: [
              {
                id: 'turn-1',
                status: 'completed',
                items: [{ type: 'agentMessage', id: 'agent-1', text: 'oldest' }],
              },
              {
                id: 'turn-2',
                status: 'failed',
                items: [{ type: 'agentMessage', id: 'agent-2', text: 'middle' }],
              },
              {
                id: 'turn-3',
                status: 'completed',
                items: [{ type: 'agentMessage', id: 'agent-3', text: 'newest' }],
              },
              {
                id: 'turn-live',
                status: 'inProgress',
                items: [{ type: 'agentMessage', id: 'agent-live', text: 'working now' }],
              },
            ],
          },
        });
      }
      throw new Error(`unexpected request: ${method} ${String(params.threadId)}`);
    });
    const projectThreadTurns = vi.fn(
      (_session: AdapterSession, turns: ThreadReadTurn[]): Promise<SubagentTranscriptUpdate[]> => {
        projectedTurnPages.push(turns.map((turn) => turn.id));
        return Promise.resolve(
          turns.flatMap((turn) =>
            turn.items
              .filter((item) => item.type === 'agentMessage')
              .map((item) => ({
                sessionUpdate: 'agent_message_chunk' as const,
                content: { type: 'text' as const, text: String(item.text) },
              }))
          )
        );
      }
    );
    const controller = new CodexSubagentController({
      codex: { request },
      requireSession: () => parent,
      createProjectionSession,
      projectThreadTurns,
      extNotification: vi.fn(() => Promise.resolve()),
    });

    const first = await controller.read({
      sessionId: 'parent-session-1',
      subagentId: 'child-thread-1',
      cursor: null,
      limit: 2,
    });

    expect(first.updates.at(-1)).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { text: 'working now' },
    });
    expect(first.projectionBoundary).toBe('turn');
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(projectedTurnPages[0]).toEqual(['turn-2', 'turn-3', 'turn-live']);

    const second = await controller.read({
      sessionId: 'parent-session-1',
      subagentId: 'child-thread-1',
      cursor: first.nextCursor,
      limit: 2,
    });
    expect(second.updates).toEqual([
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'oldest' },
      },
    ]);
    expect(second.nextCursor).toBeNull();
    expect(second.projectionBoundary).toBe('turn');
    expect(projectedTurnPages[1]).toEqual(['turn-1']);
  });

  it('rejects a foreign thread before reading its transcript', async () => {
    const parent = createSession();
    const request = vi.fn((method: string) => {
      if (method === 'thread/list') {
        return Promise.resolve({
          data: [
            {
              id: 'foreign-thread-1',
              parentThreadId: 'another-parent',
              preview: 'Must not leak',
              status: { type: 'idle' },
              turns: [],
            },
          ],
          nextCursor: null,
        });
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const controller = new CodexSubagentController({
      codex: { request },
      requireSession: () => parent,
      createProjectionSession,
      projectThreadTurns: vi.fn(() => Promise.resolve([])),
      extNotification: vi.fn(() => Promise.resolve()),
    });

    await expect(
      controller.read({
        sessionId: parent.sessionId,
        subagentId: 'foreign-thread-1',
        cursor: null,
        limit: 10,
      })
    ).rejects.toMatchObject({ code: -32_002 });
    expect(request).not.toHaveBeenCalledWith(
      'thread/read',
      expect.objectContaining({ threadId: 'foreign-thread-1' })
    );
  });

  it('rejects a mismatched transcript response before projection', async () => {
    const parent = createSession();
    const projectThreadTurns = vi.fn(() => Promise.resolve([]));
    const request = vi.fn((method: string) => {
      if (method === 'thread/list') {
        return Promise.resolve({
          data: [
            {
              id: 'requested-child',
              parentThreadId: parent.threadId,
              status: { type: 'active', activeFlags: [] },
              turns: [],
            },
          ],
          nextCursor: null,
        });
      }
      if (method === 'thread/read') {
        return Promise.resolve({
          thread: {
            id: 'different-child',
            turns: [
              {
                id: 'foreign-turn',
                status: 'completed',
                items: [{ type: 'agentMessage', id: 'foreign-answer', text: 'Do not project me' }],
              },
            ],
          },
        });
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const controller = new CodexSubagentController({
      codex: { request },
      requireSession: () => parent,
      createProjectionSession,
      projectThreadTurns,
      extNotification: vi.fn(() => Promise.resolve()),
    });

    await expect(
      controller.read({
        sessionId: parent.sessionId,
        subagentId: 'requested-child',
        cursor: null,
        limit: 10,
      })
    ).rejects.toMatchObject({ code: -32_603 });
    expect(projectThreadTurns).not.toHaveBeenCalled();
  });

  it('rejects a repeated ownership cursor without requesting the page again', async () => {
    const parent = createSession();
    let listCalls = 0;
    const request = vi.fn((method: string) => {
      if (method !== 'thread/list') {
        throw new Error(`unexpected request: ${method}`);
      }
      listCalls += 1;
      if (listCalls > 2) {
        throw new Error('ownership pagination did not terminate');
      }
      return Promise.resolve({ data: [], nextCursor: 'repeated-cursor' });
    });
    const controller = new CodexSubagentController({
      codex: { request },
      requireSession: () => parent,
      createProjectionSession,
      projectThreadTurns: vi.fn(() => Promise.resolve([])),
      extNotification: vi.fn(() => Promise.resolve()),
    });

    await expect(
      controller.read({
        sessionId: parent.sessionId,
        subagentId: 'missing-child',
        cursor: null,
        limit: 10,
      })
    ).rejects.toMatchObject({ code: -32_603 });
    expect(listCalls).toBe(2);
  });

  it('classifies malformed provider thread responses as protocol errors', async () => {
    const parent = createSession();
    const request = vi.fn((method: string) => {
      if (method === 'thread/list') {
        return Promise.resolve({
          data: [
            {
              id: 'child-thread-1',
              parentThreadId: parent.threadId,
              status: { type: 'active', activeFlags: [] },
              turns: [],
            },
          ],
          nextCursor: null,
        });
      }
      if (method === 'thread/read') {
        return Promise.resolve({ thread: { id: 'child-thread-1', turns: 'malformed' } });
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const controller = new CodexSubagentController({
      codex: { request },
      requireSession: () => parent,
      createProjectionSession,
      projectThreadTurns: vi.fn(() => Promise.resolve([])),
      extNotification: vi.fn(() => Promise.resolve()),
    });

    await expect(
      controller.read({
        sessionId: parent.sessionId,
        subagentId: 'child-thread-1',
        cursor: null,
        limit: 10,
      })
    ).rejects.toMatchObject({ code: -32_603 });
  });
});
