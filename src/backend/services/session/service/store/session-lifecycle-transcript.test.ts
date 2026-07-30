import { describe, expect, it } from 'vitest';
import type { SessionLifecycleEventRecord } from '@/backend/services/session/resources/session-lifecycle-event.accessor';
import type { ChatMessage } from '@/shared/acp-protocol';
import { mergeLifecycleTranscript, toLifecycleChatMessage } from './session-lifecycle-transcript';

const eventRecord: SessionLifecycleEventRecord = {
  id: 'event-1',
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
  kind: 'TURN_INTERRUPTED',
  reason: 'PROMPT_TIMEOUT',
  message: 'Turn stopped: reached the 4-hour limit.',
  dedupeKey: 'prompt-timeout',
  createdAt: new Date('2026-07-30T12:22:23.353Z'),
};

const providerMessageAtNoon: ChatMessage = {
  id: 'provider-at-noon',
  source: 'agent',
  timestamp: '2026-07-30T12:00:00.000Z',
  order: 0,
  message: { type: 'assistant', message: { role: 'assistant', content: 'Provider message' } },
};

const existingLifecycleMessage: ChatMessage = {
  id: 'session-lifecycle:event-1',
  source: 'agent',
  timestamp: '2026-07-30T12:22:23.353Z',
  order: 1,
  message: {
    type: 'session_lifecycle',
    timestamp: '2026-07-30T12:22:23.353Z',
    lifecycle: {
      eventId: 'event-1',
      kind: 'TURN_INTERRUPTED',
      reason: 'PROMPT_TIMEOUT',
      message: 'Turn stopped: reached the 4-hour limit.',
      timestamp: '2026-07-30T12:22:23.353Z',
    },
  },
};

describe('session lifecycle transcript', () => {
  it('maps an event to a stable structured chat message', () => {
    expect(toLifecycleChatMessage(eventRecord)).toEqual({
      id: 'session-lifecycle:event-1',
      source: 'agent',
      timestamp: '2026-07-30T12:22:23.353Z',
      order: 0,
      message: {
        type: 'session_lifecycle',
        timestamp: '2026-07-30T12:22:23.353Z',
        lifecycle: {
          eventId: 'event-1',
          kind: 'TURN_INTERRUPTED',
          reason: 'PROMPT_TIMEOUT',
          message: 'Turn stopped: reached the 4-hour limit.',
          timestamp: '2026-07-30T12:22:23.353Z',
        },
      },
    });
  });

  it('merges provider and lifecycle messages chronologically without duplicates', () => {
    const merged = mergeLifecycleTranscript(
      [providerMessageAtNoon, existingLifecycleMessage],
      [
        {
          ...eventRecord,
          id: 'event-at-eleven',
          createdAt: new Date('2026-07-30T11:00:00.000Z'),
        },
        eventRecord,
      ]
    );

    expect(merged.map((message) => message.id)).toEqual([
      'session-lifecycle:event-at-eleven',
      'provider-at-noon',
      'session-lifecycle:event-1',
    ]);
    expect(merged.map((message) => message.order)).toEqual([0, 1, 2]);
  });
});
