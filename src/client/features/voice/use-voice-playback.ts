import { useCallback, useEffect, useRef, useState } from 'react';
import { buildWebSocketUrl } from '@/lib/websocket-config';

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

interface AudioChunkMessage {
  type: 'audio_chunk';
  data: string;
  seq: number;
}

interface ClearPlaybackMessage {
  type: 'clear_playback';
}

type VoiceServerMessage = AudioChunkMessage | ClearPlaybackMessage;

const VOICE_SERVER_MESSAGE_TYPES = new Set(['audio_chunk', 'clear_playback']);

function parseVoiceServerMessage(data: unknown): VoiceServerMessage | null {
  if (typeof data !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === 'object' && VOICE_SERVER_MESSAGE_TYPES.has(parsed.type)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

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
  const wsRef = useRef<WebSocket | null>(null);
  // Guards against a burst of chunks arriving while suspended each starting
  // their own overlapping resume() call.
  const resumingRef = useRef(false);

  const playChunk = useCallback((pcm: Int16Array) => {
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

  const stopPlayback = useCallback(() => {
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
  }, []);

  const sendSoftStop = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'soft_stop' }));
    }
  }, []);

  useEffect(() => {
    if (!(enabled && sessionId)) {
      return;
    }

    // Created here — synchronously when voice mode is switched on, close to
    // the user's click — rather than lazily on the first audio chunk, which
    // arrives seconds later after transcription + the agent's turn + TTS
    // synthesis. By then the browser's autoplay policy has typically
    // suspended a freshly-created AudioContext, and buffers scheduled
    // against a suspended context play silently with no error.
    const audioContext = new AudioContext();
    audioContextRef.current = audioContext;
    nextStartTimeRef.current = 0;
    audioContext.resume().catch(() => undefined);

    const ws = new WebSocket(buildWebSocketUrl('/voice', { sessionId }));
    wsRef.current = ws;
    ws.onmessage = (event) => {
      const message = parseVoiceServerMessage(event.data);
      if (message?.type === 'audio_chunk') {
        playChunk(decodeBase64ToInt16(message.data));
      } else if (message?.type === 'clear_playback') {
        stopPlayback();
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
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
      setIsSpeaking(false);
    };
  }, [enabled, sessionId, playChunk, stopPlayback]);

  return { isSpeaking, sendSoftStop, stopPlayback };
}
