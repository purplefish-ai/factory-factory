import { afterEach, expect, it, vi } from 'vitest';
import {
  SESSION_OUTBOUND_EVENT,
  sessionEventBus,
} from '@/backend/services/session/service/session-event-bus';
import { MessageState } from '@/shared/acp-protocol';
import { parseChatServerMessage } from '@/shared/acp-protocol/protocol/chat-server-message-schema';
import { SessionPublisher } from './session-publisher';
import { buildReplayEvents } from './session-replay-builder';
import { SessionStoreRegistry } from './session-store-registry';

const timestamp = '2026-11-09T00:00:00.000Z';

function populatedStore() {
  const store = new SessionStoreRegistry().getOrCreate('wire-contract');
  store.transcript = [
    { id: 'u1', source: 'user', text: 'Fix the tests', timestamp, order: 0 },
    {
      id: 'tool',
      source: 'agent',
      timestamp,
      order: 1,
      message: {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        },
      },
    },
    {
      id: 'result',
      source: 'agent',
      timestamp,
      order: 2,
      message: {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }],
        },
      },
    },
    {
      id: 'session-lifecycle:e1',
      source: 'agent',
      timestamp,
      order: 3,
      message: {
        type: 'session_lifecycle',
        lifecycle: {
          eventId: 'e1',
          kind: 'SESSION_STOPPED',
          reason: 'SYSTEM_STOP',
          message: 'Session stopped by the system.',
          timestamp,
        },
      },
    },
  ];
  store.transcriptIdToIndex = new Map(
    store.transcript.map((message, index) => [message.id, index])
  );
  store.queue = [
    {
      id: 'q1',
      text: 'Then refactor',
      timestamp,
      settings: {
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    },
  ];
  store.recentRejections = [
    {
      id: 'rejected',
      state: MessageState.REJECTED,
      errorMessage: 'Queue full',
      rejectedAt: timestamp,
      expiresAt: Date.now() + 60_000,
    },
  ];
  store.pendingInteractiveRequest = {
    requestId: 'req-1',
    toolName: 'Bash',
    toolUseId: 't2',
    input: { command: 'rm -rf build' },
    planContent: null,
    acpOptions: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    timestamp,
  };
  store.taskPlan = {
    type: 'acp_plan',
    entries: [{ content: 'Fix tests', status: 'in_progress', priority: 'high' }],
  };
  store.runtime = {
    phase: 'running',
    processState: 'alive',
    activity: 'WORKING',
    updatedAt: timestamp,
    work: { promptInFlight: true, backgroundTasks: [], runningSubagents: 0, activeGoals: 0 },
  };
  return store;
}

const listener = vi.fn();
afterEach(() => {
  sessionEventBus.off(SESSION_OUTBOUND_EVENT, listener);
  listener.mockReset();
});

it('publishes replay events the chat client accepts without dropping any', () => {
  const store = populatedStore();
  const frame = JSON.parse(
    JSON.stringify({
      type: 'session_replay_batch',
      loadRequestId: 'load-1',
      replayEvents: buildReplayEvents(store),
    })
  );

  const parsed = parseChatServerMessage(frame);

  expect(parsed).toMatchObject({ success: true, dropped: [] });
  expect(parsed.success && parsed.message).toEqual(frame);
});

it('publishes snapshots and targeted deltas the chat client accepts', () => {
  sessionEventBus.on(SESSION_OUTBOUND_EVENT, listener);
  const store = populatedStore();
  const publisher = new SessionPublisher();

  publisher.forwardSnapshot(store, { loadRequestId: 'load-1' });
  publisher.forwardQueue(store);
  publisher.forwardPendingRequest(store);
  publisher.forwardCommittedMessage(store, store.transcript[0]!);

  const frames = listener.mock.calls.map(([event]) => JSON.parse(JSON.stringify(event.payload)));
  expect(frames.map((frame) => frame.type)).toEqual([
    'session_snapshot',
    'session_delta',
    'session_delta',
    'session_delta',
  ]);
  for (const frame of frames) {
    const parsed = parseChatServerMessage(frame);
    expect(parsed.success && parsed.message).toEqual(frame);
  }
});
