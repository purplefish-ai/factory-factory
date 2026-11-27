import { afterEach, expect, it, vi } from 'vitest';
import { createQueueMessageHandler } from '@/backend/services/session/service/chat/chat-message-handlers/handlers/queue-message.handler';
import {
  harness,
  pendingCall,
} from '@/backend/services/session/service/dispatch/session-dispatch-harness.test-helpers';
import {
  SESSION_OUTBOUND_EVENT,
  sessionEventBus,
  type SessionOutboundEvent,
} from '@/backend/services/session/service/event-bus/session-event-bus';
import {
  AcpEventProcessor,
  type AcpEventProcessorDependencies,
} from '@/backend/services/session/service/events/acp-event-processor';
import { sessionDomainService as domain } from '@/backend/services/session/service/store/session-domain.service';
import {
  chatReducer,
  createActionFromWebSocketMessage,
  createInitialChatState,
  type ChatState,
} from '@/client/features/chat/reducer';
import {
  DEFAULT_CHAT_SETTINGS,
  QUEUED_MESSAGE_ORDER_BASE,
  type ChatMessage,
  type QueuedMessage,
} from '@/shared/acp-protocol';
import { parseChatServerMessage } from '@/shared/acp-protocol/protocol/chat-server-message-schema';
import type { SessionUpdate } from '@/shared/acp-protocol/sdk-types';
import { withAutoStubs } from '@/test-utils/auto-stub';

const sid = 'session';
const submission = { type: 'queue_message', id: 'original', text: 'read the file' } as const;

function receive(state: ChatState, frame: unknown) {
  const parsed = parseChatServerMessage(JSON.parse(JSON.stringify(frame)));
  if (!parsed.success) {
    throw parsed.error;
  }
  expect(parsed.dropped).toEqual([]);
  const message = parsed.message;
  const action = createActionFromWebSocketMessage(
    message.type === 'session_delta' ? message.data : message
  );
  return action ? chatReducer(state, action) : state;
}

// Renderer timestamps for live agent rows come from the viewing machine.
function rowContent({ id, source, order, text, attachments, message }: ChatMessage) {
  return { id, source, order, text, attachments, message };
}

function observeViewers() {
  let live = createInitialChatState();
  let resumed = createInitialChatState();
  let disconnected = createInitialChatState();
  const onFrame = ({ sessionId, payload }: SessionOutboundEvent) => {
    if (sessionId !== sid) {
      return;
    }
    live = receive(live, payload);
    resumed = receive(resumed, payload);
  };
  sessionEventBus.on(SESSION_OUTBOUND_EVENT, onFrame);
  const captureReplay = () => ({
    type: 'session_replay_batch' as const,
    replayEvents: domain.prepareLoad(sid, domain.getRuntimeSnapshot(sid)).replayEvents,
  });
  return {
    close: () => sessionEventBus.off(SESSION_OUTBOUND_EVENT, onFrame),
    replyToSender(frame: unknown) {
      live = receive(live, frame);
    },
    reconnectBeforeFlush() {
      resumed = receive(disconnected, captureReplay());
    },
    checkpoint(label: string, queued: boolean) {
      const replay = captureReplay();
      const fresh = receive(createInitialChatState(), replay);
      const reconnected = receive(disconnected, replay);
      const rows = domain.getTranscriptSnapshot(sid).map(rowContent);
      if (queued) {
        rows.push(
          rowContent({
            ...submission,
            source: 'user',
            order: QUEUED_MESSAGE_ORDER_BASE,
            timestamp: '',
          })
        );
      }
      for (const [viewer, state] of Object.entries({ live, fresh, resumed, reconnected })) {
        expect([...state.queuedMessages.keys()], `${label} / ${viewer}`).toEqual(
          queued ? [submission.id] : []
        );
        expect(state.messages.map(rowContent), `${label} / ${viewer}`).toEqual(rows);
      }
      // One copy misses the next interval. The other consumes its live frames after reconnect.
      disconnected = reconnected;
      resumed = reconnected;
    },
  };
}

afterEach(() => {
  domain.clearAllSessions();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([
  { name: 'whole chunks', before: ['First line\n'], after: ['  last line'] },
  { name: 'split whitespace', before: ['First', ' line', '\n'], after: [' ', ' last', ' line'] },
])(
  'converges across admission, dispatch and interleaved ACP output with $name',
  async ({ before, after }) => {
    vi.useFakeTimers();
    const h = harness();
    const configuration = pendingCall<QueuedMessage['settings']>();
    const prompt = pendingCall();
    h.configureQueuedMessage.mockImplementationOnce(configuration.invoke);
    h.sendSessionMessage.mockImplementationOnce(prompt.invoke);
    const processor = new AcpEventProcessor({
      sessionDomainService: domain,
      runtimeManager: withAutoStubs<AcpEventProcessorDependencies['runtimeManager']>('runtime', {
        isSessionWorking: () => true,
        getClient: () => undefined,
      }),
      sessionPermissionService: withAutoStubs('permissions', {}),
      sessionConfigService: withAutoStubs('config', {}),
      onToolCallTimeout: vi.fn(),
      textFlushIntervalMs: 10,
    });
    const handler = processor.createRuntimeEventHandler(sid);
    const update = (value: SessionUpdate) =>
      handler.onAcpEvent?.(sid, { type: 'acp_session_update', update: value });
    const viewers = observeViewers();
    const chunks = (texts: string[]) => {
      for (const text of texts) {
        update({
          sessionUpdate: 'agent_message_chunk',
          messageId: 'answer',
          content: { type: 'text', text },
        });
        // The store already has this text, but its coalesced live delta is still pending.
        viewers.reconnectBeforeFlush();
        vi.advanceTimersByTime(10);
        viewers.checkpoint(`text chunk ${JSON.stringify(text)}`, false);
      }
    };
    const submit = createQueueMessageHandler({
      domain,
      backgroundDelivery: {
        captureResumeGuard: () => () => true,
        userResume: async () => undefined,
      },
      tryDispatchNextMessage: async () => undefined,
    });
    const context = { sessionId: sid, workingDir: '/tmp' };
    let dispatch: Promise<unknown> | undefined;
    const settings = { ...DEFAULT_CHAT_SETTINGS, selectedModel: null };
    try {
      await submit(context, submission);
      const retry = await submit(context, submission);
      expect(retry.replies).toHaveLength(1);
      viewers.replyToSender(retry.replies[0]);
      viewers.checkpoint('accepted and retried', true);
      dispatch = h.dispatcher.tryDispatchNextMessage(sid);
      await configuration.started;
      viewers.checkpoint('claimed during configuration', true);
      expect(h.sendSessionMessage).not.toHaveBeenCalled();
      configuration.resolve(settings);
      await prompt.started;
      viewers.checkpoint('provider handoff', false);
      processor.beginPromptTurn(sid);
      chunks(before);
      update({ sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read' });
      viewers.checkpoint('tool started', false);
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'read',
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: 'file contents' } }],
      });
      viewers.checkpoint('tool progress', false);
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed' });
      viewers.checkpoint('status-only completion', false);
      chunks(after);
      processor.finishPromptTurn(sid);
      prompt.resolve();
      await dispatch;
      viewers.checkpoint('completed turn', false);
      expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith(sid, submission.text);
      const rows = domain.getTranscriptSnapshot(sid);
      expect(rows).toHaveLength(4);
      expect(rows[0]).toMatchObject({ id: submission.id, text: submission.text });
      expect(rows[1]?.message?.message?.content).toEqual([
        { type: 'text', text: 'First line\n  last line' },
      ]);
      expect(rows[3]?.message?.message?.content).toMatchObject([
        { type: 'tool_result', tool_use_id: 'read', content: 'file contents' },
      ]);
    } finally {
      configuration.resolve(settings);
      prompt.resolve();
      await dispatch;
      processor.clearSessionState(sid);
      viewers.close();
    }
  }
);
