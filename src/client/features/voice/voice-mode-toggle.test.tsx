// @vitest-environment jsdom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { UseMicCaptureOptions } from './use-mic-capture';
import { VoiceModeToggle } from './voice-mode-toggle';

const capture = vi.hoisted(() => ({
  isCapturing: false,
  isConnecting: false,
  error: null,
  start: vi.fn(),
  stop: vi.fn(),
  options: null as UseMicCaptureOptions | null,
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError } }));
vi.mock('./use-mic-capture', () => ({
  useMicCapture: (options: UseMicCaptureOptions) => {
    capture.options = options;
    return capture;
  },
}));
const playback = vi.hoisted(() => ({ enabled: false }));
vi.mock('./use-voice-playback', () => ({
  useVoicePlayback: (options: { enabled: boolean }) => {
    playback.enabled = options.enabled;
    return { isSpeaking: false, primeAudioContext: vi.fn() };
  },
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    voice: { getConfig: { useQuery: () => ({ data: { enabled: true, hasApiKey: true } }) } },
  },
}));
vi.mock('@/client/lib/sound', () => ({ playSound: vi.fn() }));

describe('VoiceModeToggle session invalidation', () => {
  it.each([
    ['capturing', null],
    ['connecting', null],
    ['capturing', 'session-2'],
    ['connecting', 'session-2'],
  ] as const)('stops %s when the selected session changes to %s', (phase, nextSessionId) => {
    capture.isCapturing = phase === 'capturing';
    capture.isConnecting = phase === 'connecting';
    capture.stop.mockClear();
    const container = document.createElement('div');
    const root = createRoot(container);
    const render = (sessionId: string | null) =>
      flushSync(() =>
        root.render(<VoiceModeToggle sessionId={sessionId} onFinalTranscript={vi.fn()} />)
      );
    try {
      render('session-1');
      expect(capture.stop).not.toHaveBeenCalled();
      render('session-1');
      expect(capture.stop).not.toHaveBeenCalled();
      render(nextSessionId);
      expect(capture.stop).toHaveBeenCalledOnce();
    } finally {
      flushSync(() => root.unmount());
    }
  });
});

describe('VoiceModeToggle capture errors', () => {
  it('toasts each capture failure and turns voice mode back off', () => {
    capture.isCapturing = false;
    capture.isConnecting = false;
    const container = document.createElement('div');
    const root = createRoot(container);
    const button = () => container.querySelector('button');
    try {
      flushSync(() =>
        root.render(<VoiceModeToggle sessionId="session-1" onFinalTranscript={vi.fn()} />)
      );
      flushSync(() => button()?.click());
      expect(capture.start).toHaveBeenCalled();
      expect(playback.enabled).toBe(true);

      flushSync(() => capture.options?.onError?.('Microphone access was denied'));
      expect(toastError).toHaveBeenCalledWith('Microphone access was denied');
      expect(playback.enabled).toBe(false);
    } finally {
      flushSync(() => root.unmount());
    }
  });
});
