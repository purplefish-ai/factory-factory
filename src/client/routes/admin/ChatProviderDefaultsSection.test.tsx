// @vitest-environment jsdom

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chooseOption,
  createSettingsServer,
  type RenderedSettings,
  renderWithSettingsServer,
  type SettingsServer,
  type SettingsServerOptions,
  stubRadixLayout,
  waitForCheck,
} from '@/client/lib/user-settings-queries.test-harness';
import { ChatProviderDefaultsSection } from './ChatProviderDefaultsSection';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));
vi.mock('@/client/components/provider-cli-warning', () => ({ ProviderCliWarning: () => null }));

const providerOptions = {
  CLAUDE: {
    source: 'cli',
    models: [
      { value: 'default', label: 'Default — Opus 4.8 (1M)' },
      { value: 'claude-fable-5[1m]', label: 'Fable 5' },
      { value: 'sonnet', label: 'Sonnet 5' },
    ],
    efforts: [{ value: 'medium', label: 'Medium' }],
  },
  CODEX: {
    source: 'fallback',
    models: [
      { value: 'default', label: 'Default' },
      { value: 'gpt-test', label: 'Test Codex Model' },
    ],
    efforts: [{ value: 'medium', label: 'Medium' }],
  },
};

let server: SettingsServer;
let view: RenderedSettings | undefined;

async function render(options: SettingsServerOptions = {}) {
  server = createSettingsServer({
    ...options,
    handlers: { 'userSettings.getProviderOptions': () => providerOptions },
  });
  view = await renderWithSettingsServer(createElement(ChatProviderDefaultsSection), server);
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

describe('ChatProviderDefaultsSection', () => {
  it('renders Claude model labels and saves the selected raw value', async () => {
    const container = await render();
    const trigger = container.querySelector('#default-claude-model');
    expect(trigger?.textContent).toBe('Sonnet 5');

    await chooseOption(container, 'default-claude-model', 'Fable 5');

    expect(trigger?.textContent).toBe('Fable 5');
    await waitForCheck(() =>
      expect(updates()).toEqual([{ defaultClaudeModel: 'claude-fable-5[1m]' }])
    );
  });

  it('shows the raw saved model while the catalog loads', async () => {
    const savedModel = 'claude-sonnet-4-5-20250929';
    const container = await render({
      settings: { defaultClaudeModel: savedModel },
      hold: ['userSettings.getProviderOptions'],
    });
    expect(container.querySelector('#default-claude-model')?.textContent).toBe(savedModel);
  });

  it('identifies a saved Claude model absent from the catalog', async () => {
    const savedModel = 'claude-sonnet-4-5-20250929';
    const container = await render({ settings: { defaultClaudeModel: savedModel } });
    const saved = `Saved model — ${savedModel} (not in current catalog)`;
    expect(container.querySelector('#default-claude-model')?.textContent).toContain(saved);
    await chooseOption(container, 'default-claude-model', saved);
    expect(updates()).toEqual([]);
  });

  it.each([
    { id: 'default-claude-model', selected: 'Fable 5', saved: 'Sonnet 5' },
    { id: 'default-codex-model', selected: 'Test Codex Model', saved: 'Default' },
  ])('restores $id after the server rejects a model change', async ({ id, selected, saved }) => {
    const container = await render();
    server.failUpdates = 'Save rejected';
    await chooseOption(container, id, selected);
    await waitForCheck(() => expect(container.querySelector(`#${id}`)?.textContent).toBe(saved));
    expect(updates()).toHaveLength(1);
  });

  it('renders a saved one-minute turn limit with a singular label', async () => {
    const container = await render({ settings: { turnLimitMinutes: 1 } });
    expect(container.querySelector('#turn-limit')?.textContent).toBe('1 minute');
  });

  it('defaults turn limit to Unlimited and saves limits independently', async () => {
    const container = await render();
    expect(container.querySelector('#turn-limit')?.textContent).toBe('Unlimited');
    await chooseOption(container, 'turn-limit', '4 hours');
    await waitForCheck(() => expect(updates()).toEqual([{ turnLimitMinutes: 240 }]));
    expect(container.querySelector('#turn-limit')?.textContent).toBe('4 hours');
    await chooseOption(container, 'turn-limit', 'Unlimited');
    await waitForCheck(() =>
      expect(updates()).toEqual([{ turnLimitMinutes: 240 }, { turnLimitMinutes: null }])
    );
    expect(container.querySelector('#turn-limit')?.textContent).toBe('Unlimited');
  });

  it('restores the saved turn limit after a rejected change', async () => {
    const container = await render({ settings: { turnLimitMinutes: 240 } });
    server.failUpdates = 'Save rejected';
    await chooseOption(container, 'turn-limit', 'Unlimited');
    await waitForCheck(() =>
      expect(container.querySelector('#turn-limit')?.textContent).toBe('4 hours')
    );
    expect(updates()).toEqual([{ turnLimitMinutes: null }]);
  });

  it('defaults automation permissions to Auto review and saves them separately', async () => {
    const container = await render();
    expect(container.querySelector('#automation-permissions')?.textContent).toBe('Auto review');
    expect(container.querySelector('#workspace-permissions')?.textContent).toBe('Standard');
    await chooseOption(container, 'automation-permissions', 'Full access');
    await waitForCheck(() => expect(updates()).toEqual([{ automationPermissions: 'YOLO' }]));
    expect(container.querySelector('#workspace-permissions')?.textContent).toBe('Standard');
  });

  it('clears a saved effort back to the provider default', async () => {
    const container = await render({ settings: { defaultCodexReasoningEffort: 'medium' } });
    expect(container.querySelector('#default-codex-effort')?.textContent).toBe('Medium');
    await chooseOption(container, 'default-codex-effort', 'Provider default');
    await waitForCheck(() => expect(updates()).toEqual([{ defaultCodexReasoningEffort: null }]));
  });
});
