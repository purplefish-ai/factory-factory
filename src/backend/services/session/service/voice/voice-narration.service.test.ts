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
    // Mirrors real `ws`: a socket starts CONNECTING and only transitions to
    // OPEN when its 'open' event fires — matters for tests that assert on
    // behavior gated by readyState (e.g. clearActiveNarration's Clear-only-
    // if-OPEN check) before ever emitting 'open'.
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances: FakeDeepgramSocket[] = [];
    readyState = FakeDeepgramSocket.CONNECTING;
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
      if (event === 'open') {
        this.readyState = FakeDeepgramSocket.OPEN;
      }
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
      this.readyState = FakeDeepgramSocket.CLOSED;
    }
  }
  return FakeDeepgramSocket;
});

vi.mock('ws', () => ({ default: FakeDeepgramSocket }));

import {
  SESSION_OUTBOUND_EVENT,
  sessionEventBus,
} from '@/backend/services/session/service/session-event-bus';
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
      voiceTtsModel: 'aura-2-thalia-en',
      voiceTtsSpeed: 1,
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

    voiceNarrationService.unregisterConnection('sess-malformed', clientWs as never);
  });

  it('ignores a stale unregister from a replaced connection, keeping the newer one registered', async () => {
    const firstWs = createFakeClientWs();
    const secondWs = createFakeClientWs();
    voiceNarrationService.registerConnection('sess-reconnect', firstWs as never);
    voiceNarrationService.registerConnection('sess-reconnect', secondWs as never);

    // The first connection's 'close' fires after it was already replaced by
    // a reconnect — this must not wipe the second connection's state.
    voiceNarrationService.unregisterConnection('sess-reconnect', firstWs as never);

    emitDelta('sess-reconnect', {
      type: 'session_delta',
      data: { type: 'assistant_text_delta', text: 'still connected. ' },
    });

    await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
    const ttsSocket = FakeDeepgramSocket.instances[0] as InstanceType<typeof FakeDeepgramSocket>;
    ttsSocket.emit('open');
    ttsSocket.emit('message', Buffer.from([9]), true);

    expect(secondWs.send).toHaveBeenCalled();
    expect(firstWs.send).not.toHaveBeenCalled();

    voiceNarrationService.unregisterConnection('sess-reconnect', secondWs as never);
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

    voiceNarrationService.unregisterConnection('sess-reset', clientWs as never);
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

    voiceNarrationService.unregisterConnection('sess-disabled', clientWs as never);
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

    voiceNarrationService.unregisterConnection('sess-speak', clientWs as never);
  });

  describe('markdown stripping', () => {
    it('strips bold, italic, and inline code before speaking a final-answer clause', async () => {
      const clientWs = createFakeClientWs();
      voiceNarrationService.registerConnection('sess-markdown', clientWs as never);

      emitDelta('sess-markdown', {
        type: 'session_delta',
        data: {
          type: 'assistant_text_delta',
          text: 'This is **bold**, this is *italic*, and this is `code`. ',
        },
      });

      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const ttsSocket = FakeDeepgramSocket.instances[0] as InstanceType<typeof FakeDeepgramSocket>;
      ttsSocket.emit('open');

      expect(JSON.parse(ttsSocket.sentMessages[0] as string)).toEqual({
        type: 'Speak',
        text: 'This is bold, this is italic, and this is code.',
      });

      voiceNarrationService.unregisterConnection('sess-markdown', clientWs as never);
    });

    it('strips links, headers, and list markers before speaking a thinking clause', async () => {
      const clientWs = createFakeClientWs();
      voiceNarrationService.registerConnection('sess-markdown-2', clientWs as never);

      emitThinking('sess-markdown-2', '# Plan\n- Check the [docs](https://example.com) first. ');

      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const ttsSocket = FakeDeepgramSocket.instances[0] as InstanceType<typeof FakeDeepgramSocket>;
      ttsSocket.emit('open');

      expect(JSON.parse(ttsSocket.sentMessages[0] as string)).toEqual({
        type: 'Speak',
        text: 'Plan\nCheck the docs first.',
      });

      voiceNarrationService.unregisterConnection('sess-markdown-2', clientWs as never);
    });

    it('does not treat spaced asterisks (e.g. multiplication) as italic markdown', async () => {
      const clientWs = createFakeClientWs();
      voiceNarrationService.registerConnection('sess-math', clientWs as never);

      emitDelta('sess-math', {
        type: 'session_delta',
        data: { type: 'assistant_text_delta', text: 'The result is 1 * 2 * 3 = 6. ' },
      });

      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const ttsSocket = FakeDeepgramSocket.instances[0] as InstanceType<typeof FakeDeepgramSocket>;
      ttsSocket.emit('open');

      expect(JSON.parse(ttsSocket.sentMessages[0] as string)).toEqual({
        type: 'Speak',
        text: 'The result is 1 * 2 * 3 = 6.',
      });

      voiceNarrationService.unregisterConnection('sess-math', clientWs as never);
    });
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

      voiceNarrationService.unregisterConnection('sess-thinking-1', clientWs as never);
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

      voiceNarrationService.unregisterConnection('sess-thinking-2', clientWs as never);
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

      // The browser must also be told to drop any thinking audio it already
      // received and queued locally — cancelling Deepgram's synthesis alone
      // doesn't un-schedule chunks the client already has.
      expect(
        clientWs.send.mock.calls.some(
          (call) => JSON.parse(call[0] as string).type === 'clear_playback'
        )
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

      voiceNarrationService.unregisterConnection('sess-thinking-3', clientWs as never);
    });

    it('claims activeTts synchronously so a synchronous burst of thinking deltas cannot spawn duplicate sockets', async () => {
      const clientWs = createFakeClientWs();
      voiceNarrationService.registerConnection('sess-burst', clientWs as never);

      // Emitted back-to-back, synchronously — before the async settings
      // lookup inside speakClause has had any chance to resolve,
      // turn.activeTts must already be claimed by the first one.
      emitThinking('sess-burst', 'First thought completed here. ');
      emitThinking('sess-burst', 'Second thought completed here too. ');
      expect(FakeDeepgramSocket.instances).toHaveLength(0);

      await vi.waitUntil(() => FakeDeepgramSocket.instances.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(FakeDeepgramSocket.instances).toHaveLength(1);

      voiceNarrationService.unregisterConnection('sess-burst', clientWs as never);
    });

    it('does not speak stale thinking text if the socket is still connecting when the final answer cuts it off', async () => {
      const clientWs = createFakeClientWs();
      voiceNarrationService.registerConnection('sess-thinking-connecting', clientWs as never);

      emitThinking('sess-thinking-connecting', 'Reasoning about the approach now. ');
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const thinkingSocket = FakeDeepgramSocket.instances[0] as InstanceType<
        typeof FakeDeepgramSocket
      >;
      // Deliberately never emit 'open' — the socket is still CONNECTING.

      emitDelta('sess-thinking-connecting', {
        type: 'session_delta',
        data: { type: 'assistant_text_delta', text: 'The answer is 42.' },
      });

      // No Clear could be sent (the socket never opened), but the pending
      // 'open' handler must still refuse to speak once it does fire.
      expect(thinkingSocket.sentMessages).toHaveLength(0);
      thinkingSocket.emit('open');
      expect(thinkingSocket.sentMessages).toHaveLength(0);

      voiceNarrationService.unregisterConnection('sess-thinking-connecting', clientWs as never);
    });

    it('keeps buffering past a too-short opening sentence and speaks the combined clause', async () => {
      const clientWs = createFakeClientWs();
      voiceNarrationService.registerConnection('sess-thinking-short', clientWs as never);

      emitThinking('sess-thinking-short', 'Ok. ');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(FakeDeepgramSocket.instances).toHaveLength(0);

      emitThinking('sess-thinking-short', 'Let me look at the file and explain what it does. ');
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const ttsSocket = FakeDeepgramSocket.instances[0] as InstanceType<typeof FakeDeepgramSocket>;
      ttsSocket.emit('open');
      expect(JSON.parse(ttsSocket.sentMessages[0] as string)).toEqual({
        type: 'Speak',
        text: 'Ok. Let me look at the file and explain what it does.',
      });

      voiceNarrationService.unregisterConnection('sess-thinking-short', clientWs as never);
    });

    it('does not leave activeTts stuck and still drains the queue when the settings lookup throws', async () => {
      const clientWs = createFakeClientWs();
      voiceNarrationService.registerConnection('sess-throws', clientWs as never);
      mockUserSettingsService.get.mockRejectedValueOnce(new Error('boom'));

      emitThinking('sess-throws', 'This will fail to look up settings. ');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(FakeDeepgramSocket.instances).toHaveLength(0);

      // The failure must not leave activeTts stuck — a fresh clause
      // afterwards should still speak normally.
      mockUserSettingsService.get.mockResolvedValue({
        voiceModeEnabled: true,
        deepgramApiKeyEncrypted: 'enc:dg_secret',
        voiceTtsModel: 'aura-2-thalia-en',
        voiceTtsSpeed: 1,
      });
      emitThinking('sess-throws', 'This one should work fine now. ');
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);

      voiceNarrationService.unregisterConnection('sess-throws', clientWs as never);
    });
  });

  describe('incremental final-answer narration', () => {
    it('starts speaking the first sentence before the rest of a long answer has arrived', async () => {
      const clientWs = createFakeClientWs();
      voiceNarrationService.registerConnection('sess-stream', clientWs as never);

      emitDelta('sess-stream', {
        type: 'session_delta',
        data: { type: 'assistant_text_delta', text: 'This is the first sentence. ' },
      });

      // The rest of a long answer hasn't streamed in yet — narration must
      // not wait for turn-complete to start on the sentence already here.
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const firstSocket = FakeDeepgramSocket.instances[0] as InstanceType<
        typeof FakeDeepgramSocket
      >;
      firstSocket.emit('open');
      expect(JSON.parse(firstSocket.sentMessages[0] as string)).toEqual({
        type: 'Speak',
        text: 'This is the first sentence.',
      });

      voiceNarrationService.unregisterConnection('sess-stream', clientWs as never);
    });

    it('queues later clauses rather than dropping them, and speaks all of them in order', async () => {
      const clientWs = createFakeClientWs();
      voiceNarrationService.registerConnection('sess-queue', clientWs as never);

      emitDelta('sess-queue', {
        type: 'session_delta',
        data: {
          type: 'assistant_text_delta',
          text: 'Sentence one is here. Sentence two is here. Sentence three is here. ',
        },
      });

      // All three sentences arrived in a single delta — only the first
      // should start speaking; the rest must queue, not drop.
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const first = FakeDeepgramSocket.instances[0] as InstanceType<typeof FakeDeepgramSocket>;
      first.emit('open');
      expect(JSON.parse(first.sentMessages[0] as string).text).toBe('Sentence one is here.');

      first.emit('message', Buffer.from(JSON.stringify({ type: 'Flushed' })), false);
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 2);
      const second = FakeDeepgramSocket.instances[1] as InstanceType<typeof FakeDeepgramSocket>;
      second.emit('open');
      expect(JSON.parse(second.sentMessages[0] as string).text).toBe('Sentence two is here.');

      second.emit('message', Buffer.from(JSON.stringify({ type: 'Flushed' })), false);
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 3);
      const third = FakeDeepgramSocket.instances[2] as InstanceType<typeof FakeDeepgramSocket>;
      third.emit('open');
      expect(JSON.parse(third.sentMessages[0] as string).text).toBe('Sentence three is here.');

      voiceNarrationService.unregisterConnection('sess-queue', clientWs as never);
    });

    it('speaks a trailing fragment with no sentence-ending punctuation once the turn completes', async () => {
      const clientWs = createFakeClientWs();
      voiceNarrationService.registerConnection('sess-trailing', clientWs as never);

      emitDelta('sess-trailing', {
        type: 'session_delta',
        data: { type: 'assistant_text_delta', text: 'no punctuation at the end' },
      });

      // Nothing to speak yet — buffered, not a complete clause.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(FakeDeepgramSocket.instances).toHaveLength(0);

      emitRuntimeUpdate('sess-trailing', 'IDLE');

      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const socket = FakeDeepgramSocket.instances[0] as InstanceType<typeof FakeDeepgramSocket>;
      socket.emit('open');
      expect(JSON.parse(socket.sentMessages[0] as string)).toEqual({
        type: 'Speak',
        text: 'no punctuation at the end',
      });

      voiceNarrationService.unregisterConnection('sess-trailing', clientWs as never);
    });
  });
});
