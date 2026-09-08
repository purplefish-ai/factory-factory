// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatProviderDefaultsSection } from './ChatProviderDefaultsSection';

const mocks = vi.hoisted(() => ({
  updateSettingsMutate: vi.fn(),
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
      models: [{ value: 'default', label: 'Default' }],
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
      userSettings: { get: { invalidate: vi.fn() } },
    }),
    userSettings: {
      get: { useQuery: () => ({ data: mocks.userSettings, isLoading: false }) },
      update: { useMutation: () => ({ mutate: mocks.updateSettingsMutate, isPending: false }) },
      getProviderOptions: { useQuery: () => ({ data: mocks.providerOptions }) },
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userSettings.defaultClaudeModel = 'sonnet';
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
});
