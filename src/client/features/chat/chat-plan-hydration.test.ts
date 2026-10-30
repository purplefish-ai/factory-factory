import { describe, expect, it } from 'vitest';
import type { WebSocketMessage } from '@/lib/chat-protocol';
import { createInitialSessionRuntimeState } from '@/shared/session-runtime';
import { chatReducer, createActionFromWebSocketMessage, createInitialChatState } from './reducer';

describe('task snapshot hydration', () => {
  it.each([
    { label: 'a snapshot without tasks', taskPlan: undefined, expected: null },
    { label: 'an explicit absence of tasks', taskPlan: null, expected: null },
    {
      label: 'an empty task list',
      taskPlan: { type: 'acp_plan' as const, entries: [] },
      expected: [],
    },
    {
      label: 'the current task list',
      taskPlan: {
        type: 'acp_plan' as const,
        entries: [
          { content: 'Current work', status: 'in_progress' as const, priority: 'high' as const },
        ],
      },
      expected: [{ content: 'Current work', status: 'in_progress', priority: 'high' }],
    },
  ])('replaces stale task state with $label', ({ taskPlan, expected }) => {
    const state = createInitialChatState({
      acpPlan: {
        entries: [{ content: 'Old work', status: 'pending', priority: 'low' }],
        updatedAt: 'old',
      },
    });
    const message: WebSocketMessage = {
      type: 'session_snapshot',
      messages: [],
      queuedMessages: [],
      sessionRuntime: createInitialSessionRuntimeState(),
      taskPlan,
    };
    const action = createActionFromWebSocketMessage(message);
    expect(action).not.toBeNull();
    const next = action ? chatReducer(state, action) : state;
    expect(next.acpPlan?.entries ?? null).toEqual(expected);
  });
});
