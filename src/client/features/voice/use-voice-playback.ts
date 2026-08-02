import { useCallback, useEffect, useRef, useState } from 'react';
import { buildWebSocketUrl } from '@/lib/websocket-config';

/** Must match TTS_SAMPLE_RATE in voice-narration.service.ts. */
const PLAYBACK_SAMPLE_RATE = 24_000;

interface AudioChunkMessage {
  type: 'audio_chunk';
  data: string;
  seq: number;
}

function parseAudioChunkMessage(data: unknown): AudioChunkMessage | null {
  if (typeof data !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === 'object' && parsed.type === 'audio_chunk' ? parsed : null;
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

  const playChunk = useCallback((pcm: Int16Array) => {
    const audioContext = audioContextRef.current;
    if (!audioContext) {
      return;
    }
    // Browsers can suspend a context again after backgrounding the tab
    // etc.; resuming is a cheap no-op when it's already running.
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => undefined);
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

    const startAt = Math.max(audioContext.currentTime, nextStartTimeRef.current);
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
      const message = parseAudioChunkMessage(event.data);
      if (message) {
        playChunk(decodeBase64ToInt16(message.data));
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
  }, [enabled, sessionId, playChunk]);

  return { isSpeaking, sendSoftStop, stopPlayback };
}
