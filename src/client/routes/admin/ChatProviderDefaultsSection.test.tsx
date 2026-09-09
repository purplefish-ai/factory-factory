// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatProviderDefaultsSection } from './ChatProviderDefaultsSection';

const mocks = vi.hoisted(() => ({
  updateSettingsMutate: vi.fn(),
  onUpdateError: (
    _error: Error,
    _variables: { defaultClaudeModel?: string; defaultCodexModel?: string }
  ) => undefined,
  providerOptions: {
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
  },
  userSettings: {
    defaultSessionProvider: 'CLAUDE',
    defaultClaudeModel: 'sonnet',
    defaultCodexModel: 'default',
    defaultClaudeReasoningEffort: null,
    defaultCodexReasoningEffort: null,
    defaultWorkspacePermissions: 'STRICT',
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      userSettings: { get: { invalidate: vi.fn(), getData: () => mocks.userSettings } },
    }),
    userSettings: {
      get: { useQuery: () => ({ data: mocks.userSettings, isLoading: false }) },
      update: {
        useMutation: (options: { onError: typeof mocks.onUpdateError }) => {
          mocks.onUpdateError = options.onError;
          return { mutate: mocks.updateSettingsMutate, isPending: false };
        },
      },
      getProviderOptions: { useQuery: () => ({ data: mocks.providerOptions }) },
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userSettings.defaultClaudeModel = 'sonnet';
  mocks.userSettings.defaultCodexModel = 'default';
});
afterEach(() => {
  document.body.innerHTML = '';
});
vi.mock('@/client/components/provider-cli-warning', () => ({ ProviderCliWarning: () => null }));

describe('ChatProviderDefaultsSection', () => {
  it('renders Claude model labels and saves the selected raw value', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(ChatProviderDefaultsSection));
    });

    const trigger = container.querySelector<HTMLElement>('#default-claude-model');
    flushSync(() => {
      trigger?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const listbox = document.body.querySelector<HTMLElement>('[role="listbox"]');
    expect(listbox?.textContent).toContain('Default — Opus 4.8 (1M)');
    expect(listbox?.textContent).toContain('Fable 5');
    expect(listbox?.textContent).toContain('Sonnet 5');
    const fableOption = Array.from(
      listbox?.querySelectorAll<HTMLElement>('[role="option"]') ?? []
    ).find((option) => option.textContent === 'Fable 5');
    expect(fableOption).toBeDefined();

    flushSync(() => {
      fableOption?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      fableOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.updateSettingsMutate).toHaveBeenCalledWith({
      defaultClaudeModel: 'claude-fable-5[1m]',
    });

    root.unmount();
  });

  it('identifies a saved Claude model absent from the catalog', () => {
    const savedModel = 'claude-sonnet-4-5-20250929';
    mocks.userSettings.defaultClaudeModel = savedModel;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(ChatProviderDefaultsSection));
    });

    const trigger = container.querySelector<HTMLElement>('#default-claude-model');
    expect(trigger?.textContent).toContain(`Saved model — ${savedModel} (not in current catalog)`);
    flushSync(() => {
      trigger?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const listbox = document.body.querySelector<HTMLElement>('[role="listbox"]');
    expect(listbox?.textContent).toContain(`Saved model — ${savedModel} (not in current catalog)`);
    expect(listbox?.textContent).toContain('Default — Opus 4.8 (1M)');
    expect(listbox?.textContent).toContain('Fable 5');
    expect(listbox?.textContent).toContain('Sonnet 5');

    root.unmount();
  });
  it.each([
    {
      id: 'default-claude-model',
      selected: 'Fable 5',
      saved: 'Sonnet 5',
      payload: { defaultClaudeModel: 'claude-fable-5[1m]' },
    },
    {
      id: 'default-codex-model',
      selected: 'Test Codex Model',
      saved: 'Default',
      payload: { defaultCodexModel: 'gpt-test' },
    },
  ])('restores $id after the server rejects a model change', ({ id, selected, saved, payload }) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => root.render(createElement(ChatProviderDefaultsSection)));
    const trigger = container.querySelector<HTMLElement>(`#${id}`);
    flushSync(() => trigger?.click());
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (element) => element.textContent === selected
    );
    expect(option).toBeDefined();
    flushSync(() => option?.click());
    expect(trigger?.textContent).toBe(selected);
    flushSync(() => mocks.onUpdateError(new Error('Save rejected'), payload));
    expect(trigger?.textContent).toBe(saved);
    root.unmount();
  });

  it('does not overwrite a newer selection when an older model update fails', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => root.render(createElement(ChatProviderDefaultsSection)));
    const trigger = container.querySelector<HTMLElement>('#default-claude-model');
    for (const label of ['Fable 5', 'Default — Opus 4.8 (1M)']) {
      flushSync(() => trigger?.click());
      const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
        (element) => element.textContent === label
      );
      expect(option).toBeDefined();
      flushSync(() => option?.click());
    }
    flushSync(() =>
      mocks.onUpdateError(new Error('Earlier save rejected'), {
        defaultClaudeModel: 'claude-fable-5[1m]',
      })
    );
    expect(trigger?.textContent).toBe('Default — Opus 4.8 (1M)');
    root.unmount();
  });
});
