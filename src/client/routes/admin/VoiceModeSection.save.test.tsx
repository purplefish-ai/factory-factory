// @vitest-environment jsdom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSettingsServer,
  type RenderedSettings,
  renderWithSettingsServer,
  type SettingsServer,
  stubRadixLayout,
} from '@/client/lib/user-settings-queries.test-harness';
import { waitForCheck } from '@/test-utils/react-act';
import { VoiceModeSection } from './VoiceModeSection';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: toastError }, Toaster: () => null }));

let config = {
  enabled: true,
  hasApiKey: true,
  ttsModel: 'flux-haley-en',
  ttsSpeed: 1,
  utteranceEndMs: 1000,
  bargeInSustainedMs: 16,
};
let server: SettingsServer;
let view: RenderedSettings | undefined;

const updates = () => server.held.filter(({ path }) => path === 'voice.updateConfig');
const toggle = () => view?.container.querySelector<HTMLButtonElement>('#voice-mode-enabled');

beforeEach(async () => {
  vi.clearAllMocks();
  stubRadixLayout();
  config = { ...config, enabled: true };
  server = createSettingsServer({
    hold: ['voice.updateConfig'],
    handlers: { 'voice.getConfig': () => ({ ...config }) },
  });
  view = await renderWithSettingsServer(createElement(VoiceModeSection), server);
});
afterEach(async () => {
  await view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

describe('VoiceModeSection saving', () => {
  it('flips the switch at once, shows it saving and rolls back a failed save', async () => {
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    await act(async () => toggle()?.click());
    await waitForCheck(() => expect(updates()).toHaveLength(1));
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
    expect(view?.container.querySelector('[aria-label="Saving"]')).not.toBeNull();

    await act(async () => updates()[0]?.reject('Deepgram unavailable'));
    await waitForCheck(() => expect(toggle()?.getAttribute('aria-checked')).toBe('true'));
    expect(view?.container.querySelector('[aria-label="Saving"]')).toBeNull();
    expect(toastError).toHaveBeenCalledWith(
      "Couldn't save voice settings.",
      expect.objectContaining({ description: 'Deepgram unavailable' })
    );
  });

  it('keeps a newer pending change when an older one fails', async () => {
    await act(async () => toggle()?.click());
    // React Query renders cache changes on a later timer than `act` waits for;
    // until the switch shows the flip, a second click would repeat `false`.
    await waitForCheck(() => expect(toggle()?.getAttribute('aria-checked')).toBe('false'));
    await act(async () => toggle()?.click());
    await waitForCheck(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.input).toEqual({ enabled: false });
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');

    await act(async () => updates()[0]?.reject('Deepgram unavailable'));
    await waitForCheck(() => expect(updates()).toHaveLength(2));
    expect(updates()[1]?.input).toEqual({ enabled: true });
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');

    config = { ...config, enabled: true };
    await act(async () => updates()[1]?.resolve({ ...config }));
    await waitForCheck(() =>
      expect(view?.container.querySelector('[aria-label="Saving"]')).toBeNull()
    );
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
  });
});
