import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    // Mirrors real `ws`: a socket starts CONNECTING and only reaches OPEN
    // when its 'open' event fires — matters for tests asserting on behavior
    // gated by readyState (e.g. clearActiveNarration's Interrupt-only-if-OPEN
    // check) before ever emitting 'open'.
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
      const handlers = this.listeners.get(event) ?? [];
      // Mirrors EventEmitter: an 'error' with no listener throws rather than
      // being swallowed, so code that detaches its handlers and *then*
      // triggers one really does take the process down here too.
      if (event === 'error' && handlers.length === 0) {
        throw args[0] instanceof Error ? args[0] : new Error('Unhandled error event');
      }
      for (const handler of handlers) {
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
      const wasConnecting = this.readyState === FakeDeepgramSocket.CONNECTING;
      this.readyState = FakeDeepgramSocket.CLOSED;
      // Mirrors `ws`: closing a socket whose handshake never completed goes
      // through abortHandshake, which emits an 'error'.
      if (wasConnecting) {
        this.emit('error', new Error('WebSocket was closed before the connection was established'));
      }
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

function createFakeClientWs(bufferedAmount = 0) {
  return {
    readyState: 1,
    bufferedAmount,
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

/** The final-answer counterpart to emitThinking. */
function emitFinalText(sessionId: string, text: string) {
  emitDelta(sessionId, {
    type: 'session_delta',
    data: { type: 'assistant_text_delta', text },
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

/** The nth Deepgram socket opened so far, typed. */
const socketAt = (index: number) =>
  FakeDeepgramSocket.instances[index] as InstanceType<typeof FakeDeepgramSocket>;

// Tracked so `afterEach` can unregister anything a failed assertion left
// behind — each test unregisters its own connections on its success path,
// but a thrown expectation skips that, leaking a live connection/turn into
// whichever later test happens to reuse the singleton's shared internal
// state (e.g. FakeDeepgramSocket.instances).
const liveConnections: Array<{ sessionId: string; ws: never }> = [];

function register(sessionId: string, ws: never): void {
  voiceNarrationService.registerConnection(sessionId, ws);
  liveConnections.push({ sessionId, ws });
}

function unregister(sessionId: string, ws: never): void {
  voiceNarrationService.unregisterConnection(sessionId, ws);
  const index = liveConnections.findIndex((c) => c.sessionId === sessionId && c.ws === ws);
  if (index !== -1) {
    liveConnections.splice(index, 1);
  }
}

describe('voiceNarrationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FakeDeepgramSocket.instances = [];
    mockUserSettingsService.get.mockResolvedValue({
      voiceModeEnabled: true,
      deepgramApiKeyEncrypted: 'enc:dg_secret',
      voiceTtsModel: 'flux-haley-en',
      voiceTtsSpeed: 1,
    });
  });

  afterEach(() => {
    for (const { sessionId, ws } of liveConnections.splice(0)) {
      voiceNarrationService.unregisterConnection(sessionId, ws);
    }
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
    register('sess-malformed', clientWs as never);

    expect(() =>
      sessionEventBus.emit(SESSION_OUTBOUND_EVENT, {
        sessionId: 'sess-malformed',
        payload: null,
      })
    ).not.toThrow();

    unregister('sess-malformed', clientWs as never);
  });

  it('ignores a stale unregister from a replaced connection, keeping the newer one registered', async () => {
    const firstWs = createFakeClientWs();
    const secondWs = createFakeClientWs();
    register('sess-reconnect', firstWs as never);
    register('sess-reconnect', secondWs as never);

    // The first connection's 'close' fires after it was already replaced by
    // a reconnect — this must not wipe the second connection's state.
    unregister('sess-reconnect', firstWs as never);

    emitFinalText('sess-reconnect', 'still connected. ');

    await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
    const ttsSocket = socketAt(0);
    ttsSocket.emit('open');
    ttsSocket.emit('message', Buffer.from([9]), true);

    expect(secondWs.send).toHaveBeenCalled();
    expect(firstWs.send).not.toHaveBeenCalled();

    unregister('sess-reconnect', secondWs as never);
  });

  it('resets accumulated text when a new turn starts (activity WORKING)', async () => {
    const clientWs = createFakeClientWs();
    register('sess-reset', clientWs as never);

    emitFinalText('sess-reset', 'stale answer');
    emitRuntimeUpdate('sess-reset', 'WORKING');
    emitRuntimeUpdate('sess-reset', 'IDLE');

    // Turn text was cleared by WORKING before IDLE fired, so nothing should be spoken.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(FakeDeepgramSocket.instances).toHaveLength(0);

    unregister('sess-reset', clientWs as never);
  });

  it('does not synthesize speech when voice mode is disabled', async () => {
    mockUserSettingsService.get.mockResolvedValue({
      voiceModeEnabled: false,
      deepgramApiKeyEncrypted: 'enc:dg_secret',
    });
    const clientWs = createFakeClientWs();
    register('sess-disabled', clientWs as never);

    emitFinalText('sess-disabled', 'final answer');
    emitRuntimeUpdate('sess-disabled', 'IDLE');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(FakeDeepgramSocket.instances).toHaveLength(0);

    unregister('sess-disabled', clientWs as never);
  });

  it('synthesizes and forwards audio for the final answer on turn-complete', async () => {
    const clientWs = createFakeClientWs();
    register('sess-speak', clientWs as never);

    emitFinalText('sess-speak', 'Hello ');
    emitFinalText('sess-speak', 'world.');
    emitRuntimeUpdate('sess-speak', 'IDLE');

    await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
    const ttsSocket = socketAt(0);

    // Pin the whole query string, not just the endpoint: an Aura-2 model name
    // or an off-grid speed is rejected by Flux at connect time, and a bare
    // `/v2/speak` assertion would let either through.
    expect(ttsSocket.url).toBe(
      'wss://api.deepgram.com/v2/speak?model=flux-haley-en&encoding=linear16&sample_rate=24000&speed=1'
    );
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
    });

    ttsSocket.emit('message', Buffer.from(JSON.stringify({ type: 'SpeechMetadata' })), false);
    expect(JSON.parse(ttsSocket.sentMessages[2] as string)).toEqual({ type: 'Close' });

    unregister('sess-speak', clientWs as never);
  });

  it('isCurrentConnection is true only for the connection currently registered', () => {
    const firstWs = createFakeClientWs();
    const secondWs = createFakeClientWs();
    register('sess-current', firstWs as never);

    expect(voiceNarrationService.isCurrentConnection('sess-current', firstWs as never)).toBe(true);

    // A reconnect replaces the registered connection — the superseded socket
    // must no longer read as current, even though it's still open.
    register('sess-current', secondWs as never);
    expect(voiceNarrationService.isCurrentConnection('sess-current', firstWs as never)).toBe(false);
    expect(voiceNarrationService.isCurrentConnection('sess-current', secondWs as never)).toBe(true);

    unregister('sess-current', secondWs as never);
  });

  it('cancelNarration clears the active narration and queued clauses, and clears client playback', async () => {
    const clientWs = createFakeClientWs();
    register('sess-cancel', clientWs as never);

    emitFinalText('sess-cancel', 'Sentence one is here. Sentence two is here. ');

    await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
    const active = socketAt(0);
    active.emit('open');
    clientWs.send.mockClear();

    voiceNarrationService.cancelNarration('sess-cancel');

    // Cancels the in-flight clause's Deepgram synthesis...
    expect(JSON.parse(active.sentMessages.at(-1) as string)).toEqual({ type: 'Interrupt' });
    // ...and tells the client to drop whatever's already scheduled locally.
    expect(clientWs.send).toHaveBeenCalledWith(JSON.stringify({ type: 'clear_playback' }));

    // The second, still-queued clause must not start once the active one
    // settles — otherwise cancelling mid-turn would still finish speaking.
    active.emit('close');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(FakeDeepgramSocket.instances).toHaveLength(1);

    unregister('sess-cancel', clientWs as never);
  });

  it('cancels in-flight narration and clears client playback when a new turn starts mid-speech', async () => {
    const clientWs = createFakeClientWs();
    register('sess-new-turn', clientWs as never);

    emitFinalText('sess-new-turn', 'Previous turn is still speaking. ');

    await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
    const active = socketAt(0);
    active.emit('open');
    clientWs.send.mockClear();

    // A new turn starting shouldn't wait for the previous turn's narration
    // to finish on its own.
    emitRuntimeUpdate('sess-new-turn', 'WORKING');

    expect(JSON.parse(active.sentMessages.at(-1) as string)).toEqual({ type: 'Interrupt' });
    expect(clientWs.send).toHaveBeenCalledWith(JSON.stringify({ type: 'clear_playback' }));

    unregister('sess-new-turn', clientWs as never);
  });

  it('unregisterConnection cancels active narration and drains the queue', async () => {
    const clientWs = createFakeClientWs();
    register('sess-unregister', clientWs as never);

    emitFinalText('sess-unregister', 'Sentence one is here. Sentence two is here. ');

    await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
    const active = socketAt(0);
    active.emit('open');

    unregister('sess-unregister', clientWs as never);

    // Settling the now-cancelled clause must not open a fresh Deepgram
    // connection for the queued second clause — nobody's listening anymore.
    active.emit('close');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(FakeDeepgramSocket.instances).toHaveLength(1);
  });

  it('drops audio chunks once the client send buffer is backed up', async () => {
    const clientWs = createFakeClientWs(2_000_000);
    register('sess-backpressure', clientWs as never);

    emitFinalText('sess-backpressure', 'A long answer that gets spoken. ');

    await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
    const socket = socketAt(0);
    socket.emit('open');

    socket.emit('message', Buffer.from([1, 2, 3, 4]), true);

    expect(clientWs.send).not.toHaveBeenCalled();

    unregister('sess-backpressure', clientWs as never);
  });

  it('drops binary audio frames arriving for a narration already cancelled', async () => {
    const clientWs = createFakeClientWs();
    register('sess-cancelled-audio', clientWs as never);

    emitFinalText('sess-cancelled-audio', 'Answer being spoken. ');

    await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
    const socket = socketAt(0);
    socket.emit('open');
    clientWs.send.mockClear();

    voiceNarrationService.cancelNarration('sess-cancelled-audio');
    clientWs.send.mockClear();

    // Audio already in flight when Interrupt was requested keeps arriving
    // until Deepgram's SpeechInterrupted ack — it must not be forwarded to
    // the client.
    socket.emit('message', Buffer.from([9, 9, 9]), true);
    expect(clientWs.send).not.toHaveBeenCalled();

    unregister('sess-cancelled-audio', clientWs as never);
  });

  describe('markdown stripping', () => {
    it('strips bold, italic, and inline code before speaking a final-answer clause', async () => {
      const clientWs = createFakeClientWs();
      register('sess-markdown', clientWs as never);

      emitFinalText('sess-markdown', 'This is **bold**, this is *italic*, and this is `code`. ');

      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const ttsSocket = socketAt(0);
      ttsSocket.emit('open');

      expect(JSON.parse(ttsSocket.sentMessages[0] as string)).toEqual({
        type: 'Speak',
        text: 'This is bold, this is italic, and this is code.',
      });

      unregister('sess-markdown', clientWs as never);
    });

    it('strips links, headers, and list markers before speaking a thinking clause', async () => {
      const clientWs = createFakeClientWs();
      register('sess-markdown-2', clientWs as never);

      emitThinking('sess-markdown-2', '# Plan\n- Check the [docs](https://example.com) first. ');

      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const ttsSocket = socketAt(0);
      ttsSocket.emit('open');

      expect(JSON.parse(ttsSocket.sentMessages[0] as string)).toEqual({
        type: 'Speak',
        text: 'Plan\nCheck the docs first.',
      });

      unregister('sess-markdown-2', clientWs as never);
    });

    it('does not treat spaced asterisks (e.g. multiplication) as italic markdown', async () => {
      const clientWs = createFakeClientWs();
      register('sess-math', clientWs as never);

      emitFinalText('sess-math', 'The result is 1 * 2 * 3 = 6. ');

      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const ttsSocket = socketAt(0);
      ttsSocket.emit('open');

      expect(JSON.parse(ttsSocket.sentMessages[0] as string)).toEqual({
        type: 'Speak',
        text: 'The result is 1 * 2 * 3 = 6.',
      });

      unregister('sess-math', clientWs as never);
    });
  });

  describe('selective thinking narration', () => {
    it('speaks a thinking clause once a sentence boundary is reached', async () => {
      const clientWs = createFakeClientWs();
      register('sess-thinking-1', clientWs as never);

      emitThinking('sess-thinking-1', 'Let me consider this problem carefully. ');

      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const ttsSocket = socketAt(0);
      ttsSocket.emit('open');
      expect(JSON.parse(ttsSocket.sentMessages[0] as string)).toEqual({
        type: 'Speak',
        text: 'Let me consider this problem carefully.',
      });

      unregister('sess-thinking-1', clientWs as never);
    });

    it('drops a clause that arrives while a narration is already in flight', async () => {
      const clientWs = createFakeClientWs();
      register('sess-thinking-2', clientWs as never);

      emitThinking('sess-thinking-2', 'First thought completed here. ');
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);

      // Still speaking (no SpeechMetadata/SpeechInterrupted yet) — this
      // clause should be dropped, not queued, so the backlog never grows.
      emitThinking('sess-thinking-2', 'Second thought completed here too. ');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(FakeDeepgramSocket.instances).toHaveLength(1);

      // Free up the queue; a fresh clause afterwards should speak normally.
      const first = socketAt(0);
      first.emit('message', Buffer.from(JSON.stringify({ type: 'SpeechMetadata' })), false);

      emitThinking('sess-thinking-2', 'Third thought completed here. ');
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 2);

      unregister('sess-thinking-2', clientWs as never);
    });

    it('cuts off in-flight thinking narration and switches to the final answer', async () => {
      const clientWs = createFakeClientWs();
      register('sess-thinking-3', clientWs as never);

      emitThinking('sess-thinking-3', 'Reasoning about the approach now. ');
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const thinkingSocket = socketAt(0);
      thinkingSocket.emit('open');

      // Final answer starts streaming mid-thought — the in-flight thinking
      // utterance must be cut short with Deepgram's Interrupt control message.
      emitFinalText('sess-thinking-3', 'The answer is 42.');
      expect(
        thinkingSocket.sentMessages.some((m) => JSON.parse(m as string).type === 'Interrupt')
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

      thinkingSocket.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'SpeechInterrupted' })),
        false
      );

      emitRuntimeUpdate('sess-thinking-3', 'IDLE');

      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 2);
      const finalSocket = socketAt(1);
      finalSocket.emit('open');
      expect(JSON.parse(finalSocket.sentMessages[0] as string)).toEqual({
        type: 'Speak',
        text: 'The answer is 42.',
      });

      unregister('sess-thinking-3', clientWs as never);
    });

    it('settles a cancelled clause on a Warning ack, not just SpeechInterrupted, so later clauses are not stuck forever', async () => {
      const clientWs = createFakeClientWs();
      register('sess-thinking-warn', clientWs as never);

      emitThinking('sess-thinking-warn', 'Reasoning about the approach now. ');
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const thinkingSocket = socketAt(0);
      thinkingSocket.emit('open');

      // Final answer starts streaming mid-thought, cutting off the thinking
      // clause with Interrupt — but Deepgram hadn't started that clause's
      // turn yet, so it acks with a Warning (NO_AUDIO_GENERATED: "Interrupt
      // arrived before the session produced any audio") instead of
      // SpeechInterrupted, exactly like Flux does for this race in practice.
      emitFinalText('sess-thinking-warn', 'The final answer clause. Second final clause. ');
      thinkingSocket.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'Warning', code: 'NO_AUDIO_GENERATED' })),
        false
      );

      // Without settling on the Warning, activeTts stays stuck on the
      // cancelled thinking clause and no final-answer socket ever opens.
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 2);
      const first = socketAt(1);
      first.emit('open');
      expect(JSON.parse(first.sentMessages[0] as string).text).toBe('The final answer clause.');

      // And the queue keeps draining past the first clause too.
      first.emit('message', Buffer.from(JSON.stringify({ type: 'SpeechMetadata' })), false);
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 3);
      const second = socketAt(2);
      second.emit('open');
      expect(JSON.parse(second.sentMessages[0] as string).text).toBe('Second final clause.');

      unregister('sess-thinking-warn', clientWs as never);
    });

    it('settles an uncancelled clause that Deepgram declined to synthesize, so later clauses still speak', async () => {
      const clientWs = createFakeClientWs();
      register('sess-warn-no-audio', clientWs as never);

      // Non-empty after stripMarkdownForSpeech so it is still sent, but there
      // is nothing to say: Flux answers Flush with NO_AUDIO_GENERATED and no
      // SpeechMetadata follows. Nothing was cancelled, so the old
      // `cancelled &&` guard ignored it and stranded activeTts.
      emitFinalText('sess-warn-no-audio', '🎉🎊✨🎈🎁🎀🥳. Real words follow after it. ');

      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const emojiSocket = socketAt(0);
      emojiSocket.emit('open');
      expect(JSON.parse(emojiSocket.sentMessages[0] as string).text).toBe('🎉🎊✨🎈🎁🎀🥳.');
      emojiSocket.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'Warning', code: 'NO_AUDIO_GENERATED' })),
        false
      );

      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 2);
      const next = socketAt(1);
      next.emit('open');
      expect(JSON.parse(next.sentMessages[0] as string).text).toBe('Real words follow after it.');

      unregister('sess-warn-no-audio', clientWs as never);
    });

    it('normalizes a legacy off-grid stored speed before opening the connection', async () => {
      // Rows written before the grid was enforced at the write boundary can
      // still hold 0.72, which Deepgram rejects with SPEED_INCREMENT_INVALID
      // on every connection. The stored value alone must not reach the URL.
      mockUserSettingsService.get.mockResolvedValue({
        voiceModeEnabled: true,
        deepgramApiKeyEncrypted: 'enc:dg_secret',
        voiceTtsModel: 'flux-haley-en',
        voiceTtsSpeed: 0.72,
      });
      const clientWs = createFakeClientWs();
      register('sess-legacy-speed', clientWs as never);

      emitFinalText('sess-legacy-speed', 'Speaks at a legacy speed. ');

      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      expect(new URL(socketAt(0).url).searchParams.get('speed')).toBe('0.7');
      unregister('sess-legacy-speed', clientWs as never);
    });

    it('keeps waiting for SpeechMetadata when a Warning arrives after audio has started, so speech is not clipped', async () => {
      const clientWs = createFakeClientWs();
      register('sess-warn-midstream', clientWs as never);

      emitFinalText('sess-warn-midstream', 'Audio flows here. Then more words follow. ');

      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const socket = socketAt(0);
      socket.emit('open');
      // An unrecognized Warning before the first frame may still be followed
      // by audio, so it must not drop the clause — only NO_AUDIO_GENERATED
      // means nothing is coming.
      socket.emit('message', Buffer.from(JSON.stringify({ type: 'Warning' })), false);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(FakeDeepgramSocket.instances).toHaveLength(1);

      // And once audio is in flight a Warning is informational too —
      // finishing on it would clip speech mid-utterance.
      socket.emit('message', Buffer.from([1, 2, 3, 4]), true);
      socket.emit('message', Buffer.from(JSON.stringify({ type: 'Warning' })), false);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(FakeDeepgramSocket.instances).toHaveLength(1);

      // Only SpeechMetadata ends it, and then the queue drains normally.
      socket.emit('message', Buffer.from(JSON.stringify({ type: 'SpeechMetadata' })), false);
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 2);
      const second = socketAt(1);
      second.emit('open');
      expect(JSON.parse(second.sentMessages[0] as string).text).toBe('Then more words follow.');
      unregister('sess-warn-midstream', clientWs as never);
    });

    it('claims activeTts synchronously so a synchronous burst of thinking deltas cannot spawn duplicate sockets', async () => {
      const clientWs = createFakeClientWs();
      register('sess-burst', clientWs as never);

      // Emitted back-to-back, synchronously — before the async settings
      // lookup inside speakClause has had any chance to resolve,
      // turn.activeTts must already be claimed by the first one.
      emitThinking('sess-burst', 'First thought completed here. ');
      emitThinking('sess-burst', 'Second thought completed here too. ');
      expect(FakeDeepgramSocket.instances).toHaveLength(0);

      await vi.waitUntil(() => FakeDeepgramSocket.instances.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(FakeDeepgramSocket.instances).toHaveLength(1);

      unregister('sess-burst', clientWs as never);
    });

    it('does not speak stale thinking text if the socket is still connecting when the final answer cuts it off', async () => {
      const clientWs = createFakeClientWs();
      register('sess-thinking-connecting', clientWs as never);

      emitThinking('sess-thinking-connecting', 'Reasoning about the approach now. ');
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const thinkingSocket = socketAt(0);
      // Deliberately never emit 'open' — the socket is still CONNECTING.

      emitFinalText('sess-thinking-connecting', 'The answer is 42.');

      // No Interrupt could be sent (the socket never opened), but the pending
      // 'open' handler must still refuse to speak once it does fire.
      expect(thinkingSocket.sentMessages).toHaveLength(0);
      thinkingSocket.emit('open');
      expect(thinkingSocket.sentMessages).toHaveLength(0);

      unregister('sess-thinking-connecting', clientWs as never);
    });

    it('keeps buffering past a too-short opening sentence and speaks the combined clause', async () => {
      const clientWs = createFakeClientWs();
      register('sess-thinking-short', clientWs as never);

      emitThinking('sess-thinking-short', 'Ok. ');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(FakeDeepgramSocket.instances).toHaveLength(0);

      emitThinking('sess-thinking-short', 'Let me look at the file and explain what it does. ');
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const ttsSocket = socketAt(0);
      ttsSocket.emit('open');
      expect(JSON.parse(ttsSocket.sentMessages[0] as string)).toEqual({
        type: 'Speak',
        text: 'Ok. Let me look at the file and explain what it does.',
      });

      unregister('sess-thinking-short', clientWs as never);
    });

    it('does not leave activeTts stuck and still drains the queue when the settings lookup throws', async () => {
      const clientWs = createFakeClientWs();
      register('sess-throws', clientWs as never);
      mockUserSettingsService.get.mockRejectedValueOnce(new Error('boom'));

      emitThinking('sess-throws', 'This will fail to look up settings. ');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(FakeDeepgramSocket.instances).toHaveLength(0);

      // The failure must not leave activeTts stuck — a fresh clause
      // afterwards should still speak normally.
      mockUserSettingsService.get.mockResolvedValue({
        voiceModeEnabled: true,
        deepgramApiKeyEncrypted: 'enc:dg_secret',
        voiceTtsModel: 'flux-haley-en',
        voiceTtsSpeed: 1,
      });
      emitThinking('sess-throws', 'This one should work fine now. ');
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);

      unregister('sess-throws', clientWs as never);
    });
  });

  describe('incremental final-answer narration', () => {
    it('starts speaking the first sentence before the rest of a long answer has arrived', async () => {
      const clientWs = createFakeClientWs();
      register('sess-stream', clientWs as never);

      emitFinalText('sess-stream', 'This is the first sentence. ');

      // The rest of a long answer hasn't streamed in yet — narration must
      // not wait for turn-complete to start on the sentence already here.
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const firstSocket = socketAt(0);
      firstSocket.emit('open');
      expect(JSON.parse(firstSocket.sentMessages[0] as string)).toEqual({
        type: 'Speak',
        text: 'This is the first sentence.',
      });

      unregister('sess-stream', clientWs as never);
    });

    it('queues later clauses rather than dropping them, and speaks all of them in order', async () => {
      const clientWs = createFakeClientWs();
      register('sess-queue', clientWs as never);

      emitFinalText(
        'sess-queue',
        'Sentence one is here. Sentence two is here. Sentence three is here. '
      );

      // All three sentences arrived in a single delta — only the first
      // should start speaking; the rest must queue, not drop.
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const first = socketAt(0);
      first.emit('open');
      expect(JSON.parse(first.sentMessages[0] as string).text).toBe('Sentence one is here.');

      first.emit('message', Buffer.from(JSON.stringify({ type: 'SpeechMetadata' })), false);
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 2);
      const second = socketAt(1);
      second.emit('open');
      expect(JSON.parse(second.sentMessages[0] as string).text).toBe('Sentence two is here.');

      second.emit('message', Buffer.from(JSON.stringify({ type: 'SpeechMetadata' })), false);
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 3);
      const third = socketAt(2);
      third.emit('open');
      expect(JSON.parse(third.sentMessages[0] as string).text).toBe('Sentence three is here.');

      unregister('sess-queue', clientWs as never);
    });

    it('speaks a trailing fragment with no sentence-ending punctuation once the turn completes', async () => {
      const clientWs = createFakeClientWs();
      register('sess-trailing', clientWs as never);

      emitFinalText('sess-trailing', 'no punctuation at the end');

      // Nothing to speak yet — buffered, not a complete clause.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(FakeDeepgramSocket.instances).toHaveLength(0);

      emitRuntimeUpdate('sess-trailing', 'IDLE');

      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const socket = socketAt(0);
      socket.emit('open');
      expect(JSON.parse(socket.sentMessages[0] as string)).toEqual({
        type: 'Speak',
        text: 'no punctuation at the end',
      });

      unregister('sess-trailing', clientWs as never);
    });
  });

  describe('connection retry', () => {
    it('retries a handshake failure that happens before open, and still speaks the clause', async () => {
      const clientWs = createFakeClientWs();
      register('sess-retry-ok', clientWs as never);

      emitFinalText('sess-retry-ok', 'This clause should survive one bad handshake. ');

      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const first = socketAt(0);
      // Fails before 'open' — the exact shape of a rejected handshake, as
      // opposed to a mid-stream error after audio has already started.
      first.emit('error', new Error('socket hang up'));

      // A second connection attempt should follow after the retry delay.
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 2);
      const second = socketAt(1);
      second.emit('open');
      expect(JSON.parse(second.sentMessages[0] as string)).toEqual({
        type: 'Speak',
        text: 'This clause should survive one bad handshake.',
      });

      unregister('sess-retry-ok', clientWs as never);
    });

    it('gives up after exhausting retries and still drains the next queued clause', async () => {
      const clientWs = createFakeClientWs();
      register('sess-retry-exhausted', clientWs as never);

      emitFinalText(
        'sess-retry-exhausted',
        'This clause always fails to connect. Second clause speaks fine. '
      );

      // Fail three times in a row (initial attempt + two retries) — every
      // attempt for the first clause.
      for (let i = 0; i < 3; i++) {
        await vi.waitUntil(() => FakeDeepgramSocket.instances.length === i + 1);
        const socket = socketAt(i);
        socket.emit('error', new Error('socket hang up'));
      }

      // No further retry beyond the third attempt — but the queue still
      // drains: the second clause gets its own fresh connection.
      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 4);
      const secondClause = socketAt(3);
      secondClause.emit('open');
      expect(JSON.parse(secondClause.sentMessages[0] as string)).toEqual({
        type: 'Speak',
        text: 'Second clause speaks fine.',
      });

      unregister('sess-retry-exhausted', clientWs as never);
    });

    it('does not retry a failure that happens after the socket already opened', async () => {
      const clientWs = createFakeClientWs();
      register('sess-retry-post-open', clientWs as never);

      emitFinalText('sess-retry-post-open', 'Opens fine then drops mid-stream. ');

      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const socket = socketAt(0);
      socket.emit('open');
      socket.emit('error', new Error('connection reset'));

      // Waits past the 300ms retry delay so a wrongly-scheduled retry would
      // actually have fired by the time this asserts it didn't.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(FakeDeepgramSocket.instances).toHaveLength(1);

      unregister('sess-retry-post-open', clientWs as never);
    });

    it('retries an unexpected-response rejection without an unhandled error event', async () => {
      const clientWs = createFakeClientWs();
      register('sess-retry-unexpected', clientWs as never);

      emitFinalText('sess-retry-unexpected', 'Rejected with an HTTP status. ');

      await vi.waitUntil(() => FakeDeepgramSocket.instances.length === 1);
      const first = socketAt(0);
      // Deepgram rejects the upgrade with a 400 while the socket is still
      // CONNECTING, so aborting the handshake emits 'error' — which must
      // not escape unhandled.
      expect(() => first.emit('unexpected-response', {}, { statusCode: 400 })).not.toThrow();
      expect(first.readyState).toBe(FakeDeepgramSocket.CLOSED);

      const second = await vi.waitUntil(() => socketAt(1));
      second.emit('open');
      expect(JSON.parse(second.sentMessages[0] as string).text).toBe(
        'Rejected with an HTTP status.'
      );

      unregister('sess-retry-unexpected', clientWs as never);
    });
  });
});
