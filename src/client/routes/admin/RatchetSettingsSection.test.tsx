// @vitest-environment jsdom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chooseOption,
  createSettingsServer,
  type RenderedSettings,
  renderWithSettingsServer,
  type SettingsServer,
  stubRadixLayout,
} from '@/client/lib/user-settings-queries.test-harness';
import { waitForCheck } from '@/test-utils/react-act';
import { RatchetSettingsSection } from './RatchetSettingsSection';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));
vi.mock('@/client/features/workspace', () => ({ RatchetWrenchIcon: () => createElement('span') }));

let server: SettingsServer;
let view: RenderedSettings | undefined;

async function render(options: Parameters<typeof createSettingsServer>[0] = {}) {
  server = createSettingsServer({
    ...options,
    handlers: {
      'admin.triggerRatchetCheck': () => ({ checked: 1, stateChanges: 0, actionsTriggered: 0 }),
      ...options.handlers,
    },
  });
  view = await renderWithSettingsServer(createElement(RatchetSettingsSection), server);
  return view.container;
}

const updates = () =>
  server.requests.filter(({ path }) => path === 'userSettings.update').map(({ input }) => input);

beforeEach(() => {
  vi.clearAllMocks();
  stubRadixLayout();
});
afterEach(async () => {
  await view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

describe('RatchetSettingsSection', () => {
  it('shows the load error with Retry instead of editable defaults', async () => {
    server = createSettingsServer({ hold: ['userSettings.get'] });
    view = await renderWithSettingsServer(createElement(RatchetSettingsSection), server);
    await act(async () => server.held[0]?.reject('Database is locked'));
    const container = view.container;
    await waitForCheck(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Couldn't load PR update settings"
      )
    );
    expect(container.textContent).toContain('Database is locked');
    expect(container.querySelector('[role="switch"]')).toBeNull();
    expect(container.querySelector('#ratchet-review-trigger')).toBeNull();

    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry'
    );
    await act(async () => retry?.click());
    await act(async () => server.held[1]?.resolve({ ...server.settings, ratchetEnabled: true }));
    await waitForCheck(() =>
      expect(container.querySelector('#ratchet-enabled')?.getAttribute('aria-checked')).toBe('true')
    );
  });

  it('flips a switch at once and shows it saving until the server answers', async () => {
    const container = await render({ hold: ['userSettings.update'] });
    const toggle = container.querySelector<HTMLButtonElement>('#ratchet-enabled');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');

    await act(async () => toggle?.click());
    await waitForCheck(() => expect(toggle?.getAttribute('aria-checked')).toBe('true'));
    expect(toggle?.disabled).toBe(false);
    expect(container.querySelector('[aria-label="Saving"]')).not.toBeNull();
    expect(updates()).toEqual([{ ratchetEnabled: true }]);

    await act(async () => server.held[0]?.respond());
    await waitForCheck(() => expect(container.querySelector('[aria-label="Saving"]')).toBeNull());
    expect(toggle?.getAttribute('aria-checked')).toBe('true');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('keeps Ratchet settings without auto-iteration permission controls', async () => {
    const container = await render();
    expect(container.textContent).toContain('Review feedback trigger');
    expect(container.textContent).not.toMatch(/auto.iteration/i);
    expect(container.querySelector('#auto-iteration-permissions')).toBeNull();
  });

  it('updates the Ratchet review feedback trigger mode', async () => {
    const container = await render();
    const trigger = container.querySelector('#ratchet-review-trigger');
    expect(trigger?.textContent).toContain('Changes requested and unresolved threads');

    await chooseOption(container, 'ratchet-review-trigger', 'All review feedback');

    await waitForCheck(() =>
      expect(updates()).toEqual([{ ratchetReviewTriggerMode: 'ALL_REVIEW_FEEDBACK' }])
    );
    expect(trigger?.textContent).toContain('All review feedback');
  });
});
