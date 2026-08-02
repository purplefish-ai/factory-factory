import { useCallback, useRef, useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import { SpeechActivityDetector } from './voice-activity';

const DEEPGRAM_STT_URL = 'wss://api.deepgram.com/v1/listen';
const TARGET_SAMPLE_RATE = 16_000;
const WORKLET_MODULE_URL = '/audio-worklets/pcm-capture-processor.js';

/**
 * Only scanned while the agent turn is running (see `running` option) — this
 * naturally disambiguates a command from normal dictation, since these
 * phrases only mean "stop" mid-turn.
 */
const STOP_PHRASES = ['stop', 'please stop', 'hold on', 'wait', 'cancel that'];

export function matchesStopPhrase(transcript: string): boolean {
  const normalized = transcript.trim().toLowerCase();
  return STOP_PHRASES.some((phrase) => normalized.includes(phrase));
}

interface DeepgramResultsMessage {
  type: 'Results';
  is_final?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string }> };
}

function parseDeepgramMessage(data: unknown): DeepgramResultsMessage | null {
  if (typeof data !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === 'object' && parsed.type === 'Results') {
      return parsed as DeepgramResultsMessage;
    }
  } catch {
    // Not JSON we care about
  }
  return null;
}

export interface UseMicCaptureOptions {
  /** Called with the final transcript of an utterance. */
  onFinalTranscript: (text: string) => void;
  /** Called with in-progress transcript text as the user is still speaking. */
  onInterimTranscript?: (text: string) => void;
  /** Whether the agent turn is currently running — gates stop-phrase scanning. */
  running?: boolean;
  /** Called when an interim transcript matches a stop phrase while `running`. */
  onSoftStop?: () => void;
  /** Called the instant sustained speech is detected (for barge-in). */
  onSpeechDetected?: () => void;
}

export interface UseMicCaptureResult {
  isCapturing: boolean;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
}

/**
 * Captures the mic and streams raw PCM directly to Deepgram's streaming STT
 * over a browser-to-Deepgram WebSocket, authenticated with a short-lived
 * grant token minted server-side so the long-lived API key never reaches
 * the browser.
 */
export function useMicCapture({
  onFinalTranscript,
  onInterimTranscript,
  running,
  onSoftStop,
  onSpeechDetected,
}: UseMicCaptureOptions): UseMicCaptureResult {
  const [isCapturing, setIsCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mintGrantToken = trpc.voice.mintGrantToken.useMutation();

  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const speechDetectorRef = useRef<SpeechActivityDetector | null>(null);
  // Read fresh each call without forcing start()/cleanup() to re-run —
  // `running` flips mid-capture as the agent turn starts and finishes.
  const runningRef = useRef(running ?? false);
  runningRef.current = running ?? false;

  const cleanup = useCallback(() => {
    workletNodeRef.current?.port.close();
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;
    silentGainRef.current?.disconnect();
    silentGainRef.current = null;
    audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    for (const track of mediaStreamRef.current?.getTracks() ?? []) {
      track.stop();
    }
    mediaStreamRef.current = null;
    const socket = socketRef.current;
    if (socket) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'CloseStream' }));
      }
      socket.close();
    }
    socketRef.current = null;
    speechDetectorRef.current = null;
    setIsCapturing(false);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const { accessToken } = await mintGrantToken.mutateAsync();

      const params = new URLSearchParams({
        model: 'nova-3',
        // Required explicitly: Deepgram has reported project/model access
        // failures for nova-3 connections that omit language, even though
        // English is the model's default.
        language: 'en',
        encoding: 'linear16',
        sample_rate: String(TARGET_SAMPLE_RATE),
        channels: '1',
        interim_results: 'true',
        smart_format: 'true',
        vad_events: 'true',
        access_token: accessToken,
      });
      const socket = new WebSocket(`${DEEPGRAM_STT_URL}?${params.toString()}`);
      socketRef.current = socket;

      socket.onmessage = (event) => {
        const message = parseDeepgramMessage(event.data);
        const transcript = message?.channel?.alternatives?.[0]?.transcript;
        if (!transcript) {
          return;
        }
        if (message?.is_final) {
          onFinalTranscript(transcript);
          return;
        }
        onInterimTranscript?.(transcript);
        if (runningRef.current && matchesStopPhrase(transcript)) {
          onSoftStop?.();
        }
      };

      // Browsers deliberately withhold the HTTP-level detail of a rejected WS
      // handshake from JS (security restriction) — `error` carries nothing,
      // and even `close` usually just reports code 1006 with no reason. The
      // close code is still worth surfacing since it at least distinguishes
      // failure classes; the actual cause (status/body) is only visible in
      // the browser's Network panel.
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener(
          'close',
          (event) => {
            reject(
              new Error(
                `Failed to connect to Deepgram (WebSocket closed, code ${event.code}${event.reason ? `: ${event.reason}` : ''}). Check the browser Network tab for the actual handshake response.`
              )
            );
          },
          { once: true }
        );
      });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      await audioContext.audioWorklet.addModule(WORKLET_MODULE_URL);

      const source = audioContext.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioContext, 'pcm-capture-processor', {
        processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE },
      });
      workletNodeRef.current = workletNode;
      speechDetectorRef.current = new SpeechActivityDetector();

      workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(event.data);
        }
        if (onSpeechDetected && speechDetectorRef.current?.observe(new Int16Array(event.data))) {
          onSpeechDetected();
        }
      };

      // A worklet node only runs while it's part of a graph reaching the
      // destination; route through a silent gain so we never play the mic
      // back but the node still gets pulled for processing.
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      silentGainRef.current = silentGain;
      source.connect(workletNode);
      workletNode.connect(silentGain);
      silentGain.connect(audioContext.destination);

      setIsCapturing(true);
    } catch (err) {
      cleanup();
      setError(err instanceof Error ? err.message : 'Failed to start voice capture');
    }
  }, [
    cleanup,
    mintGrantToken,
    onFinalTranscript,
    onInterimTranscript,
    onSoftStop,
    onSpeechDetected,
  ]);

  const stop = useCallback(() => {
    cleanup();
  }, [cleanup]);

  return { isCapturing, error, start, stop };
}
