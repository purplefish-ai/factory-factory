// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VoiceModeSection } from './VoiceModeSection';

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), validate: vi.fn() }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ voice: { getConfig: { setData: vi.fn(), invalidate: vi.fn() } } }),
    voice: {
      getConfig: {
        useQuery: () => ({
          data: { enabled: true, hasApiKey: true, ttsSpeed: 1, ttsModel: 'flux-haley-en' },
          isLoading: false,
        }),
      },
      updateConfig: { useMutation: () => ({ mutate: mocks.mutate, isPending: false }) },
      validateApiKey: {
        useMutation: (options: {
          onSuccess: (result: { valid: boolean }, input: { apiKey: string }) => void;
        }) => ({
          mutate: (input: { apiKey: string }) => {
            mocks.validate(input);
            options.onSuccess({ valid: true }, input);
          },
          isPending: false,
        }),
      },
    },
  },
}));
vi.mock('@/components/ui/slider', () => ({
  Slider: ({
    id,
    value,
    step,
    onValueCommit,
  }: {
    id: string;
    value: number[];
    step: number;
    onValueCommit: (values: number[]) => void;
  }) => (
    <button type="button" data-testid={id} onClick={() => onValueCommit([(value[0] ?? 0) + step])}>
      Adjust {id}
    </button>
  ),
}));
vi.mock('@/components/ui/select', () => ({
  Select: ({ onValueChange }: { onValueChange: (value: string) => void }) => (
    <button type="button" data-testid="voice-select" onClick={() => onValueChange('flux-jack-en')}>
      Choose voice
    </button>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => children,
  SelectItem: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
});
afterEach(() => {
  document.body.innerHTML = '';
});

it.each(['voice-speed', 'voice-utterance-end', 'voice-barge-in', 'voice-select'])(
  'does not resend cached enabled when adjusting %s',
  (id) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    void act(() => root.render(<VoiceModeSection />));
    void act(() => container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)?.click());
    expect(mocks.mutate).toHaveBeenCalled();
    expect(mocks.mutate.mock.calls[0]?.[0]).not.toHaveProperty('enabled');
    void act(() => root.unmount());
  }
);

it('does not resend cached enabled when saving a validated API key', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  void act(() => root.render(<VoiceModeSection />));
  const input = container.querySelector<HTMLInputElement>('#deepgram-api-key');
  void act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      'new-key'
    );
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  void act(() =>
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Validate')
      ?.click()
  );
  expect(mocks.validate).toHaveBeenCalledWith({ apiKey: 'new-key' });
  void act(() =>
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save')
      ?.click()
  );
  expect(mocks.mutate.mock.calls[0]?.[0]).toEqual({ apiKey: 'new-key' });
  void act(() => root.unmount());
});

it('still sends enabled when the user changes the enable switch', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  void act(() => root.render(<VoiceModeSection />));
  void act(() => container.querySelector<HTMLButtonElement>('[role="switch"]')?.click());
  expect(mocks.mutate.mock.calls[0]?.[0]).toEqual({ enabled: false });
  void act(() => root.unmount());
});
