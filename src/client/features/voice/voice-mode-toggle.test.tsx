// @vitest-environment jsdom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { VoiceModeToggle } from './voice-mode-toggle';

const capture = vi.hoisted(() => ({
  isCapturing: false,
  isConnecting: false,
  error: null,
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('./use-mic-capture', () => ({ useMicCapture: () => capture }));
vi.mock('./use-voice-playback', () => ({
  useVoicePlayback: () => ({ isSpeaking: false, primeAudioContext: vi.fn() }),
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
