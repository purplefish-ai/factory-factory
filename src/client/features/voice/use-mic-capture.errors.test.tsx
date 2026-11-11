// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type UseMicCaptureResult, useMicCapture } from './use-mic-capture';

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    voice: {
      mintGrantToken: {
        useMutation: () => ({
          mutateAsync: () => Promise.reject(new Error('Voice is not configured')),
        }),
      },
    },
  },
}));

class FakeAudioContext {
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

let result: UseMicCaptureResult | null = null;

function Harness({ onError }: { onError: (message: string) => void }) {
  result = useMicCapture({ onFinalTranscript: vi.fn(), onError });
  return null;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
  result = null;
});

describe('useMicCapture errors', () => {
  it('reports a failed start through onError as well as error', async () => {
    const onError = vi.fn();
    const root = createRoot(document.createElement('div'));
    act(() => root.render(createElement(Harness, { onError })));

    await act(() => result?.start());

    expect(onError).toHaveBeenCalledExactlyOnceWith('Voice is not configured');
    expect(result?.error).toBe('Voice is not configured');
    expect(result?.isConnecting).toBe(false);
    act(() => root.unmount());
  });
});
