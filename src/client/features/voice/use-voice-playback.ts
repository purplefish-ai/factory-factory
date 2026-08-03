import { useCallback, useEffect, useRef, useState } from 'react';
import { useWebSocketChannel } from '@/hooks/use-websocket-channel';
import { buildWebSocketUrl } from '@/lib/websocket-config';
import {
  type VoiceServerMessage,
  VoiceServerMessageSchema,
} from '@/shared/websocket/voice-message.schema';

/** Must match TTS_SAMPLE_RATE in voice-narration.service.ts. */
const PLAYBACK_SAMPLE_RATE = 24_000;
/**
 * Cushion added before starting playback whenever the scheduled runway has
 * run dry (start of an utterance, or a stall). Deepgram doesn't deliver a
 * steady bitrate, so without this, scheduling a chunk flush against
 * `currentTime` means the next moment of network jitter produces an audible
 * gap — and every chunk after that keeps re-triggering the same gap.
 *
 * Deepgram streams audio in ~40ms chunks (measured from real sessions), so
 * a 120ms cushion was only ~3 chunks of headroom against a busy main thread
 * that's also re-rendering the streaming chat transcript concurrently — not
 * enough. 300ms trades a bit more onset latency (barely noticeable in a
 * spoken conversation) for real robustness against that contention.
 */
const JITTER_BUFFER_SECONDS = 0.3;
/**
 * How long to accumulate incoming ~40ms chunks before merging them into one
 * scheduled AudioBuffer. Deepgram's own official streaming-TTS examples
 * (deepgram-starters/live-text-to-speech-html, voice-agent-html) schedule
 * one buffer per network chunk with no coalescing and only a 100ms
 * lookahead — proven, but their demo doesn't relay audio through a second
 * WebSocket hop off a Node process that's concurrently running a coding
 * agent's tool calls and chat streaming, the way this app does. Batching
 * ~3 chunks per buffer cuts the Web Audio scheduling/allocation rate ~4x —
 * the same technique the `pcm-player` library uses for jittery sources —
 * while keeping the identical chained-offset scheduler below.
 */
const COALESCE_WINDOW_MS = 120;

function decodeBase64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

export interface UseVoicePlaybackOptions {
  sessionId: string | null;
  enabled: boolean;
}

export interface UseVoicePlaybackResult {
  isSpeaking: boolean;
  /** Sends a soft_stop control message over the same /voice connection. */
  sendSoftStop: () => void;
  /**
   * Barge-in: immediately stops any playing/queued audio. Client-side only —
   * independent of whether the interruption also becomes a soft_stop.
   */
  stopPlayback: () => void;
  /**
   * Creates (or resumes) the playback AudioContext. Must be called
   * synchronously from a user gesture (the mic button's click handler) —
   * see its call site for why.
   */
  primeAudioContext: () => void;
  /**
   * Barge-in start: stops current playback (like `stopPlayback`) and, unlike
   * it, also suppresses further `audio_chunk`s until `endBargeIn()` — the
   * server-side narration for the interrupted clause keeps streaming chunks
   * for a beat after the client detects speech, and without suppression
   * those chunks would immediately restart playback on top of the user still
   * talking.
   */
  beginBargeIn: () => void;
  /** Barge-in end: resumes accepting `audio_chunk`s once the user stops talking. */
  endBargeIn: () => void;
}

/**
 * Connects to /voice and plays back Deepgram-synthesized linear16 PCM audio
 * chunks in order via the Web Audio API. Deepgram's TTS output is headerless
 * raw PCM, not a container format, so chunks are scheduled as AudioBuffers
 * built by hand rather than through `decodeAudioData`.
 */
export function useVoicePlayback({
  sessionId,
  enabled,
}: UseVoicePlaybackOptions): UseVoicePlaybackResult {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const activeSourcesRef = useRef(new Set<AudioBufferSourceNode>());
  // Guards against a burst of chunks arriving while suspended each starting
  // their own overlapping resume() call.
  const resumingRef = useRef(false);
  // Set for the duration of a barge-in (see beginBargeIn/endBargeIn) so
  // audio_chunks that keep arriving from the interrupted clause's still-
  // streaming server-side narration are dropped instead of restarting
  // playback on top of the user's speech.
  const suppressedRef = useRef(false);
  // Chunks received but not yet merged into a scheduled buffer — see
  // COALESCE_WINDOW_MS.
  const pendingChunksRef = useRef<Int16Array[]>([]);
  const coalesceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelCoalescing = useCallback(() => {
    if (coalesceTimerRef.current !== null) {
      clearTimeout(coalesceTimerRef.current);
      coalesceTimerRef.current = null;
    }
    pendingChunksRef.current = [];
  }, []);

  const schedulePcm = useCallback((pcm: Int16Array) => {
    const audioContext = audioContextRef.current;
    if (!audioContext) {
      return;
    }
    // Browsers can suspend a context again after backgrounding the tab
    // etc.; resuming is a cheap no-op when it's already running.
    if (audioContext.state === 'suspended' && !resumingRef.current) {
      resumingRef.current = true;
      audioContext
        .resume()
        .catch(() => undefined)
        .finally(() => {
          resumingRef.current = false;
        });
    }
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      samples[i] = (pcm[i] ?? 0) / 0x80_00;
    }

    const buffer = audioContext.createBuffer(1, samples.length, PLAYBACK_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);

    // Once the scheduled runway is behind "now", this is either the first
    // chunk of a fresh utterance or a stall from a network gap — either way,
    // resume with a fresh cushion rather than flush against currentTime.
    const isUnderrun = nextStartTimeRef.current <= audioContext.currentTime;
    const startAt = isUnderrun
      ? audioContext.currentTime + JITTER_BUFFER_SECONDS
      : nextStartTimeRef.current;
    source.start(startAt);
    nextStartTimeRef.current = startAt + buffer.duration;

    activeSourcesRef.current.add(source);
    setIsSpeaking(true);
    source.onended = () => {
      activeSourcesRef.current.delete(source);
      if (activeSourcesRef.current.size === 0) {
        setIsSpeaking(false);
      }
    };
  }, []);

  const flushPending = useCallback(() => {
    coalesceTimerRef.current = null;
    const chunks = pendingChunksRef.current;
    pendingChunksRef.current = [];
    if (chunks.length === 0) {
      return;
    }
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Int16Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    schedulePcm(merged);
  }, [schedulePcm]);

  const enqueueChunk = useCallback(
    (pcm: Int16Array) => {
      pendingChunksRef.current.push(pcm);
      // Only the first chunk of a batch arms the timer — later chunks just
      // join the same window, which is what bounds it to COALESCE_WINDOW_MS
      // rather than restarting on every arrival.
      if (coalesceTimerRef.current === null) {
        coalesceTimerRef.current = setTimeout(flushPending, COALESCE_WINDOW_MS);
      }
    },
    [flushPending]
  );

  const stopPlayback = useCallback(() => {
    cancelCoalescing();
    for (const source of activeSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // Already stopped/ended — fine to ignore.
      }
    }
    activeSourcesRef.current.clear();
    nextStartTimeRef.current = audioContextRef.current?.currentTime ?? 0;
    setIsSpeaking(false);
  }, [cancelCoalescing]);

  // Creates (or resumes) the AudioContext. Exposed so the mic button's click
  // handler can call it synchronously, inside the user gesture — otherwise
  // (e.g. creating it lazily in the effect below, after the `enabled` state
  // update has propagated through a render) some browsers reject the resume
  // as not originating from a gesture, and the freshly-created context stays
  // suspended: buffers scheduled against it play silently with no error, no
  // audio, no signal anything is wrong.
  const primeAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
      nextStartTimeRef.current = 0;
    }
    audioContextRef.current.resume().catch(() => undefined);
  }, []);

  const handleMessage = useCallback(
    (message: VoiceServerMessage) => {
      if (message.type === 'audio_chunk') {
        if (suppressedRef.current) {
          return;
        }
        enqueueChunk(decodeBase64ToInt16(message.data));
      } else if (message.type === 'clear_playback') {
        stopPlayback();
      }
    },
    [enqueueChunk, stopPlayback]
  );

  const beginBargeIn = useCallback(() => {
    suppressedRef.current = true;
    stopPlayback();
  }, [stopPlayback]);

  const endBargeIn = useCallback(() => {
    suppressedRef.current = false;
  }, []);

  // useWebSocketChannel (built on useWebSocketTransport) gives this
  // connection automatic reconnection with backoff — a transient drop no
  // longer permanently strands voice mode with narration silently
  // discarded server-side and no way to hear it — and, via the default
  // 'replay' queue policy, queues an outbound soft_stop sent while
  // momentarily disconnected instead of dropping the interrupt.
  const url = enabled && sessionId ? buildWebSocketUrl('/voice', { sessionId }) : null;
  const { send } = useWebSocketChannel({
    url,
    schema: VoiceServerMessageSchema,
    onMessage: handleMessage,
  });

  const sendSoftStop = useCallback(() => {
    send({ type: 'soft_stop' });
  }, [send]);

  // AudioContext lifecycle tracks `enabled`/`sessionId` directly (not the
  // websocket connection state) so a transient reconnect doesn't tear down
  // and recreate — and lose the scheduled-playback timeline of — the audio
  // graph.
  useEffect(() => {
    if (!(enabled && sessionId)) {
      return;
    }
    primeAudioContext();

    return () => {
      cancelCoalescing();
      for (const source of activeSourcesRef.current) {
        try {
          source.stop();
        } catch {
          // Already stopped/ended — fine to ignore.
        }
      }
      activeSourcesRef.current.clear();
      audioContextRef.current?.close().catch(() => undefined);
      audioContextRef.current = null;
      nextStartTimeRef.current = 0;
      suppressedRef.current = false;
      setIsSpeaking(false);
    };
  }, [enabled, sessionId, cancelCoalescing, primeAudioContext]);

  return { isSpeaking, sendSoftStop, stopPlayback, primeAudioContext, beginBargeIn, endBargeIn };
}
