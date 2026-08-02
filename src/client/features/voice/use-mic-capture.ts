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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary matched so words that merely contain a stop phrase as a
// substring — "await", "stopwatch" — don't spuriously cancel the turn.
const STOP_PHRASE_PATTERNS = STOP_PHRASES.map(
  (phrase) => new RegExp(`\\b${escapeRegExp(phrase)}\\b`)
);

export function matchesStopPhrase(transcript: string): boolean {
  const normalized = transcript.trim().toLowerCase();
  return STOP_PHRASE_PATTERNS.some((pattern) => pattern.test(normalized));
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

interface CaptureResources {
  workletNode: AudioWorkletNode | null;
  silentGain: GainNode | null;
  audioContext: AudioContext | null;
  mediaStream: MediaStream | null;
  socket: WebSocket | null;
}

/** Tears down every resource a capture attempt may have created. */
function disposeCaptureResources({
  workletNode,
  silentGain,
  audioContext,
  mediaStream,
  socket,
}: CaptureResources): void {
  workletNode?.port.close();
  workletNode?.disconnect();
  silentGain?.disconnect();
  audioContext?.close().catch(() => undefined);
  for (const track of mediaStream?.getTracks() ?? []) {
    track.stop();
  }
  if (socket) {
    socket.onclose = null;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'CloseStream' }));
    }
    socket.close();
  }
}

/**
 * Browsers deliberately withhold the HTTP-level detail of a rejected WS
 * handshake from JS (security restriction) — `error` carries nothing, and
 * even `close` usually just reports code 1006 with no reason. The close
 * code is still worth surfacing since it at least distinguishes failure
 * classes; the actual cause (status/body) is only visible in the browser's
 * Network panel.
 */
function waitForSocketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
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
}

function createDeepgramSocket(accessToken: string): WebSocket {
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
  });
  // Grant tokens (JWTs from /v1/auth/grant) are rejected as INVALID_AUTH
  // when passed via an ?access_token= query param on this endpoint, despite
  // Deepgram's own docs suggesting that works — verified live against a
  // real account. The Sec-WebSocket-Protocol subprotocol list is the one
  // auth channel a browser WebSocket can actually set without custom
  // headers, and Deepgram does accept the token there under the "bearer"
  // subprotocol (mirroring their documented `["token", apiKey]` pattern for
  // raw API keys).
  return new WebSocket(`${DEEPGRAM_STT_URL}?${params.toString()}`, ['bearer', accessToken]);
}

/** Loads the capture worklet and wires the (silent, never played back) audio graph. */
async function setupAudioGraph(
  audioContext: AudioContext,
  stream: MediaStream
): Promise<{ workletNode: AudioWorkletNode; silentGain: GainNode }> {
  await audioContext.audioWorklet.addModule(WORKLET_MODULE_URL);

  const source = audioContext.createMediaStreamSource(stream);
  const workletNode = new AudioWorkletNode(audioContext, 'pcm-capture-processor', {
    processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE },
  });
  // A worklet node only runs while it's part of a graph reaching the
  // destination; route through a silent gain so we never play the mic back
  // but the node still gets pulled for processing.
  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  source.connect(workletNode);
  workletNode.connect(silentGain);
  silentGain.connect(audioContext.destination);

  return { workletNode, silentGain };
}

interface TranscriptHandlerDeps {
  runningRef: { current: boolean };
  onSoftStop?: () => void;
  onFinalTranscript: (text: string) => void;
  onInterimTranscript?: (text: string) => void;
}

function attachTranscriptHandler(socket: WebSocket, deps: TranscriptHandlerDeps): void {
  socket.onmessage = (event) => {
    const message = parseDeepgramMessage(event.data);
    const transcript = message?.channel?.alternatives?.[0]?.transcript;
    if (!transcript) {
      return;
    }
    // Checked before the interim/final branch below: a short phrase like
    // "stop now" can arrive directly as Deepgram's final result without
    // ever appearing in an interim first, so gating this on the interim
    // path only would silently send it as a chat message instead.
    if (deps.runningRef.current && matchesStopPhrase(transcript)) {
      deps.onSoftStop?.();
      return;
    }
    if (message?.is_final) {
      deps.onFinalTranscript(transcript);
      return;
    }
    deps.onInterimTranscript?.(transcript);
  };
}

interface PcmForwarderDeps {
  socketRef: { current: WebSocket | null };
  speechDetectorRef: { current: SpeechActivityDetector | null };
  onSpeechDetected?: () => void;
}

function attachPcmForwarder(workletNode: AudioWorkletNode, deps: PcmForwarderDeps): void {
  workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    if (deps.socketRef.current?.readyState === WebSocket.OPEN) {
      deps.socketRef.current.send(event.data);
    }
    if (
      deps.onSpeechDetected &&
      deps.speechDetectorRef.current?.observe(new Int16Array(event.data))
    ) {
      deps.onSpeechDetected();
    }
  };
}

interface DisconnectHandlerDeps {
  isStale: () => boolean;
  cleanup: () => void;
  setError: (message: string) => void;
}

/**
 * A disconnect after capture has started (network drop, Deepgram-side
 * close) is unexpected — release capture resources and surface a
 * reconnectable error instead of leaving the mic/audio graph running with a
 * dead socket.
 */
function attachDisconnectHandler(socket: WebSocket, deps: DisconnectHandlerDeps): void {
  socket.onclose = (event) => {
    if (deps.isStale()) {
      return;
    }
    deps.cleanup();
    deps.setError(
      `Lost connection to Deepgram (code ${event.code}). Tap the microphone to reconnect.`
    );
  };
}

interface CaptureAttemptResult {
  socket: WebSocket;
  stream: MediaStream;
  audioContext: AudioContext;
  workletNode: AudioWorkletNode;
  silentGain: GainNode;
  speechDetector: SpeechActivityDetector;
}

interface CaptureAttemptDeps
  extends TranscriptHandlerDeps,
    Omit<PcmForwarderDeps, 'speechDetectorRef'>,
    Omit<DisconnectHandlerDeps, 'isStale'> {
  mintGrantToken: { mutateAsync: () => Promise<{ accessToken: string }> };
  isStale: () => boolean;
}

/**
 * Runs the full connect sequence (mint token, open socket, get the mic,
 * wire the audio graph), checking `isStale` after each await. Returns null
 * — having already disposed whatever it created — the moment the attempt is
 * superseded by a newer start() or a stop() mid-connect; throws for a real
 * failure, having disposed first so a failed attempt never leaks resources.
 */
async function attemptCapture(deps: CaptureAttemptDeps): Promise<CaptureAttemptResult | null> {
  let socket: WebSocket | null = null;
  let stream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let silentGain: GainNode | null = null;

  const disposeLocal = () =>
    disposeCaptureResources({ workletNode, silentGain, audioContext, mediaStream: stream, socket });

  try {
    const { accessToken } = await deps.mintGrantToken.mutateAsync();
    if (deps.isStale()) {
      disposeLocal();
      return null;
    }

    socket = createDeepgramSocket(accessToken);
    attachTranscriptHandler(socket, deps);

    await waitForSocketOpen(socket);
    if (deps.isStale()) {
      disposeLocal();
      return null;
    }

    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (deps.isStale()) {
      disposeLocal();
      return null;
    }

    audioContext = new AudioContext();
    const graph = await setupAudioGraph(audioContext, stream);
    if (deps.isStale()) {
      disposeLocal();
      return null;
    }
    workletNode = graph.workletNode;
    silentGain = graph.silentGain;

    const speechDetector = new SpeechActivityDetector();
    attachPcmForwarder(workletNode, { ...deps, speechDetectorRef: { current: speechDetector } });
    attachDisconnectHandler(socket, deps);

    return { socket, stream, audioContext, workletNode, silentGain, speechDetector };
  } catch (err) {
    disposeLocal();
    throw err;
  }
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
  /** True once the mic is open and streaming to Deepgram — speech before this is dropped. */
  isCapturing: boolean;
  /** True from the moment `start()` is called until capture is ready (or fails). */
  isConnecting: boolean;
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
  const [isConnecting, setIsConnecting] = useState(false);
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

  // Bumped by stop() and by every start() call. A start() attempt checks
  // this after each await; if it no longer matches the generation it was
  // issued under, it has been superseded (a newer start(), or an exit while
  // it was still connecting) and must dispose of its own local resources
  // instead of committing them to the refs or touching capture/error state.
  const generationRef = useRef(0);

  const cleanup = useCallback(() => {
    disposeCaptureResources({
      workletNode: workletNodeRef.current,
      silentGain: silentGainRef.current,
      audioContext: audioContextRef.current,
      mediaStream: mediaStreamRef.current,
      socket: socketRef.current,
    });
    workletNodeRef.current = null;
    silentGainRef.current = null;
    audioContextRef.current = null;
    mediaStreamRef.current = null;
    socketRef.current = null;
    speechDetectorRef.current = null;
    setIsCapturing(false);
  }, []);

  const start = useCallback(async () => {
    generationRef.current += 1;
    const myGeneration = generationRef.current;
    const isStale = () => generationRef.current !== myGeneration;

    setError(null);
    setIsConnecting(true);
    try {
      const resources = await attemptCapture({
        mintGrantToken,
        isStale,
        runningRef,
        onSoftStop,
        onFinalTranscript,
        onInterimTranscript,
        onSpeechDetected,
        socketRef,
        cleanup,
        setError,
      });
      if (!resources) {
        // Superseded mid-connect — attemptCapture already disposed of
        // whatever it had created.
        return;
      }
      socketRef.current = resources.socket;
      mediaStreamRef.current = resources.stream;
      audioContextRef.current = resources.audioContext;
      workletNodeRef.current = resources.workletNode;
      silentGainRef.current = resources.silentGain;
      speechDetectorRef.current = resources.speechDetector;
      setIsCapturing(true);
    } catch (err) {
      if (!isStale()) {
        setError(err instanceof Error ? err.message : 'Failed to start voice capture');
      }
    } finally {
      if (!isStale()) {
        setIsConnecting(false);
      }
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
    generationRef.current += 1;
    cleanup();
  }, [cleanup]);

  return { isCapturing, isConnecting, error, start, stop };
}
