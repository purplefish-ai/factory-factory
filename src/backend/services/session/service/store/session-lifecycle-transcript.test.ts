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

  it('fast-paths an empty lifecycle event set without reordering provider history', () => {
    const transcript = Array.from({ length: 12 }, (_, index) => ({
      ...providerMessageAtNoon,
      id: `provider-${index}`,
      order: index,
    }));

    const merged = mergeLifecycleTranscript(transcript, []);

    expect(merged).toBe(transcript);
    expect(merged.map((message) => message.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `provider-${index}`)
    );
  });

  it('preserves 10+ tied provider blocks even when their ids sort in another order', () => {
    const transcript = Array.from({ length: 12 }, (_, index) => ({
      ...providerMessageAtNoon,
      id: `provider-${index}`,
      order: index,
    }));
    const tiedLifecycleEvent = {
      ...eventRecord,
      createdAt: new Date(providerMessageAtNoon.timestamp),
    };

    const merged = mergeLifecycleTranscript(transcript, [tiedLifecycleEvent]);

    expect(merged.map((message) => message.id)).toEqual([
      ...Array.from({ length: 12 }, (_, index) => `provider-${index}`),
      'session-lifecycle:event-1',
    ]);
  });

  it('compares parsed instants and preserves provider order for offset-equivalent timestamps', () => {
    const transcript: ChatMessage[] = [
      {
        ...providerMessageAtNoon,
        id: 'provider-z',
        timestamp: '2026-07-30T08:00:00.000-04:00',
        order: 0,
      },
      {
        ...providerMessageAtNoon,
        id: 'provider-a',
        timestamp: '2026-07-30T12:00:00.000Z',
        order: 1,
      },
    ];

    const merged = mergeLifecycleTranscript(transcript, [
      {
        ...eventRecord,
        createdAt: new Date('2026-07-30T12:00:00.000Z'),
      },
    ]);

    expect(merged.map((message) => message.id)).toEqual([
      'provider-z',
      'provider-a',
      'session-lifecycle:event-1',
    ]);
    expect(merged.map((message) => message.order)).toEqual([0, 1, 2]);
  });
});
