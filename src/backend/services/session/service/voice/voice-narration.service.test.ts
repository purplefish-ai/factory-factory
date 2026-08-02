import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUserSettingsService = vi.hoisted(() => ({ get: vi.fn() }));
const mockCryptoService = vi.hoisted(() => ({
  decrypt: vi.fn((v: string) => v.replace(/^enc:/, '')),
}));

vi.mock('@/backend/services/settings', () => ({ userSettingsService: mockUserSettingsService }));
vi.mock('@/backend/services/crypto.service', () => ({ cryptoService: mockCryptoService }));

const FakeDeepgramSocket = vi.hoisted(() => {
  // A minimal hand-rolled emitter so this factory doesn't depend on any
  // module import — vitest hoists `vi.mock`/`vi.hoisted` factories above
  // even static imports, so importing `node:events` here would hit a TDZ.
  class FakeDeepgramSocket {
    static OPEN = 1;
    static instances: FakeDeepgramSocket[] = [];
    readyState = FakeDeepgramSocket.OPEN;
    sentMessages: string[] = [];
    url: string;
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(url: string, _options?: unknown) {
      this.url = url;
      FakeDeepgramSocket.instances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
      const existing = this.listeners.get(event) ?? [];
      existing.push(handler);
      this.listeners.set(event, existing);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.listeners.get(event) ?? []) {
        handler(...args);
      }
    }

    removeAllListeners(): this {
      this.listeners.clear();
      return this;
    }

    send(data: string): void {
      this.sentMessages.push(data);
    }

    close(): void {
      this.readyState = 3;
    }
  }
  return FakeDeepgramSocket;
});

vi.mock('ws', () => ({ default: FakeDeepgramSocket }));

import { SESSION_OUTBOUND_EVENT, sessionEventBus } from '../session-event-bus';
import { voiceNarrationService } from './voice-narration.service';

function createFakeClientWs() {
  return {
    readyState: 1,
    send: vi.fn(),
  };
}

function emitDelta(sessionId: string, payload: Record<string, unknown>) {
  sessionEventBus.emit(SESSION_OUTBOUND_EVENT, { sessionId, payload });
}

function emitThinking(sessionId: string, thinking: string) {
  emitDelta(sessionId, {
    type: 'session_delta',
    data: {
      type: 'agent_message',
      data: {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking },
        },
      },
    },
  });
}

/**
 * Matches how SessionPublisher.emitDelta actually publishes this event in
 * production (session-publisher.ts) — always wrapped in a session_delta
 * envelope, never as a bare top-level session_runtime_updated message. A
 * previous version of this helper (and the service code under test) used
 * the bare shape, which meant these tests validated the implementation
 * against itself rather than against what the backend really sends.
 */
function emitRuntimeUpdate(sessionId: string, activity: 'WORKING' | 'IDLE') {
  emitDelta(sessionId, {
    type: 'session_delta',
    data: { type: 'session_runtime_updated', sessionRuntime: { activity } },
  });
}

describe('voiceNarrationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FakeDeepgramSocket.instances = [];
    mockUserSettingsService.get.mockResolvedValue({
      voiceModeEnabled: true,
      deepgramApiKeyEncrypted: 'enc:dg_secret',
    });
  });

  it('ignores events for sessions with no registered voice connection', () => {
    expect(() =>
      emitDelta('unregistered-session', {
        type: 'session_delta',
        data: { type: 'assistant_text_delta', text: 'hello' },
      })
    ).not.toThrow();
    expect(FakeDeepgramSocket.instances).toHaveLength(0);
  });

  it('does not throw when a malformed event reaches the listener (fail-closed)', () => {
    const clientWs = createFakeClientWs();
    voiceNarrationService.registerConnection('sess-malformed', clientWs as never);

    expect(() =>
      sessionEventBus.emit(SESSION_OUTBOUND_EVENT, {
        sessionId: 'sess-malformed',
        payload: null,
      })
    ).not.toThrow();

    voiceNarrationService.unregisterConnection('sess-malformed');
  });

  it('resets accumulated text when a new turn starts (activity WORKING)', async () => {
    const clientWs = createFakeClientWs();
    voiceNarrationService.registerConnection('sess-reset', clientWs as never);

    emitDelta('sess-reset', {
      type: 'session_delta',
      data: { type: 'assistant_text_delta', text: 'stale answer' },
    });
    emitRuntimeUpdate('sess-reset', 'WORKING');
    emitRuntimeUpdate('sess-reset', 'IDLE');

    // Turn text was cleared by WORKING before IDLE fired, so nothing should be spoken.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(FakeDeepgramSocket.instances).toHaveLength(0);

    voiceNarrationService.unregisterConnection('sess-reset');
  });

  it('does not synthesize speech when voice mode is disabled', async () => {
    mockUserSettingsService.get.mockResolvedValue({
      voiceModeEnabled: false,
      deepgramApiKeyEncrypted: 'enc:dg_secret',
    });
    const clientWs = createFakeClientWs();
    voiceNarrationService.registerConnection('sess-disabled', clientWs as never);

    emitDelta('sess-disabled', {
      type: 'session_delta',
      data: { type: 'assistant_text_delta', text: 'final answer' },
    });
    emitRuntimeUpdate('sess-disabled', 'IDLE');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(FakeDeepgramSocket.instances).toHaveLength(0);

    voiceNarrationService.unregisterConnection('sess-disabled');
  });

  it('synthesizes and forwards audio for the final answer on turn-complete', async () => {
    const clientWs = createFakeClientWs();
    voiceNarrationService.registerConnection('sess-speak', clientWs as never);

    emitDelta('sess-speak', {
      type: 'session_delta',
      data: { type: 'assistant_text_delta', text: 'Hello ' },
    });
    emitDelta('sess-speak', {
      type: 'session_delta',
      data: { type: 'assistant_text_delta', text: 'world.' },
    });
    emitRuntimeUpdate('sess-speak', 'IDLE');

    await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
    const ttsSocket = FakeDeepgramSocket.instances[0] as InstanceType<typeof FakeDeepgramSocket>;

    expect(ttsSocket.url).toContain('wss://api.deepgram.com/v1/speak');
    expect(mockCryptoService.decrypt).toHaveBeenCalledWith('enc:dg_secret');

    ttsSocket.emit('open');
    expect(JSON.parse(ttsSocket.sentMessages[0] as string)).toEqual({
      type: 'Speak',
      text: 'Hello world.',
    });
    expect(JSON.parse(ttsSocket.sentMessages[1] as string)).toEqual({ type: 'Flush' });

    const audioBytes = Buffer.from([1, 2, 3, 4]);
    ttsSocket.emit('message', audioBytes, true);

    expect(clientWs.send).toHaveBeenCalledTimes(1);
    const forwarded = JSON.parse(clientWs.send.mock.calls[0]?.[0] as string);
    expect(forwarded).toEqual({
      type: 'audio_chunk',
      data: audioBytes.toString('base64'),
      seq: 1,
    });

    ttsSocket.emit('message', Buffer.from(JSON.stringify({ type: 'Flushed' })), false);
    expect(JSON.parse(ttsSocket.sentMessages[2] as string)).toEqual({ type: 'Close' });

    voiceNarrationService.unregisterConnection('sess-speak');
  });

  describe('selective thinking narration', () => {
    it('speaks a thinking clause once a sentence boundary is reached', async () => {
      const clientWs = createFakeClientWs();
      voiceNarrationService.registerConnection('sess-thinking-1', clientWs as never);

      emitThinking('sess-thinking-1', 'Let me consider this problem carefully. ');

      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const ttsSocket = FakeDeepgramSocket.instances[0] as InstanceType<typeof FakeDeepgramSocket>;
      ttsSocket.emit('open');
      expect(JSON.parse(ttsSocket.sentMessages[0] as string)).toEqual({
        type: 'Speak',
        text: 'Let me consider this problem carefully.',
      });

      voiceNarrationService.unregisterConnection('sess-thinking-1');
    });

    it('drops a clause that arrives while a narration is already in flight', async () => {
      const clientWs = createFakeClientWs();
      voiceNarrationService.registerConnection('sess-thinking-2', clientWs as never);

      emitThinking('sess-thinking-2', 'First thought completed here. ');
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);

      // Still speaking (no Flushed/Cleared yet) — this clause should be dropped,
      // not queued, so the backlog never grows.
      emitThinking('sess-thinking-2', 'Second thought completed here too. ');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(FakeDeepgramSocket.instances).toHaveLength(1);

      // Free up the queue; a fresh clause afterwards should speak normally.
      const first = FakeDeepgramSocket.instances[0] as InstanceType<typeof FakeDeepgramSocket>;
      first.emit('message', Buffer.from(JSON.stringify({ type: 'Flushed' })), false);

      emitThinking('sess-thinking-2', 'Third thought completed here. ');
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 2);

      voiceNarrationService.unregisterConnection('sess-thinking-2');
    });

    it('cuts off in-flight thinking narration and switches to the final answer', async () => {
      const clientWs = createFakeClientWs();
      voiceNarrationService.registerConnection('sess-thinking-3', clientWs as never);

      emitThinking('sess-thinking-3', 'Reasoning about the approach now. ');
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const thinkingSocket = FakeDeepgramSocket.instances[0] as InstanceType<
        typeof FakeDeepgramSocket
      >;
      thinkingSocket.emit('open');

      // Final answer starts streaming mid-thought — the in-flight thinking
      // utterance must be cut short with Deepgram's Clear control message.
      emitDelta('sess-thinking-3', {
        type: 'session_delta',
        data: { type: 'assistant_text_delta', text: 'The answer is 42.' },
      });
      expect(
        thinkingSocket.sentMessages.some((m) => JSON.parse(m as string).type === 'Clear')
      ).toBe(true);

      // Further thinking deltas this turn are ignored entirely now.
      emitThinking('sess-thinking-3', 'This should never be spoken. ');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(FakeDeepgramSocket.instances).toHaveLength(1);

      thinkingSocket.emit('message', Buffer.from(JSON.stringify({ type: 'Cleared' })), false);

      emitRuntimeUpdate('sess-thinking-3', 'IDLE');

      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 2);
      const finalSocket = FakeDeepgramSocket.instances[1] as InstanceType<
        typeof FakeDeepgramSocket
      >;
      finalSocket.emit('open');
      expect(JSON.parse(finalSocket.sentMessages[0] as string)).toEqual({
        type: 'Speak',
        text: 'The answer is 42.',
      });

      voiceNarrationService.unregisterConnection('sess-thinking-3');
    });
  });
});
