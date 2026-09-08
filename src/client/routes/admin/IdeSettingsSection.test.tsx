// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdeSettingsSection } from './IdeSettingsSection';

const mocks = vi.hoisted(() => ({
  updateSettingsMutate: vi.fn(),
  testCustomCommandMutate: vi.fn(),
  userSettings: {
    preferredIde: 'cursor' as 'cursor' | 'vscode' | 'custom',
    customIdeCommand: null as string | null,
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      userSettings: { get: { invalidate: vi.fn() } },
      workspace: { getAvailableIdes: { invalidate: vi.fn() } },
    }),
    userSettings: {
      get: { useQuery: () => ({ data: mocks.userSettings, isLoading: false }) },
      update: { useMutation: () => ({ mutate: mocks.updateSettingsMutate, isPending: false }) },
      testCustomCommand: {
        useMutation: () => ({ mutate: mocks.testCustomCommandMutate, isPending: false }),
      },
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userSettings.preferredIde = 'cursor';
  mocks.userSettings.customIdeCommand = null;
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('IdeSettingsSection', () => {
  it('preserves the saved custom command when switching to a built-in IDE', () => {
    mocks.userSettings.preferredIde = 'custom';
    mocks.userSettings.customIdeCommand = 'code-insiders {workspace}';

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(IdeSettingsSection));
    });

    const trigger = container.querySelector<HTMLElement>('#ide-select');

    flushSync(() => {
      trigger?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const listbox = document.body.querySelector<HTMLElement>('[role="listbox"]');
    const cursorOption = Array.from(
      listbox?.querySelectorAll<HTMLElement>('[role="option"]') ?? []
    ).find((option) => option.textContent === 'Cursor');
    expect(cursorOption).toBeDefined();

    flushSync(() => {
      cursorOption?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      cursorOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.updateSettingsMutate).toHaveBeenCalledWith({
      preferredIde: 'cursor',
    });

    root.unmount();
  });

  it('tests the current custom command before it has been saved', () => {
    mocks.userSettings.preferredIde = 'custom';
    mocks.userSettings.customIdeCommand = null;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(IdeSettingsSection));
    });

    const input = container.querySelector<HTMLInputElement>('#custom-command');
    const testButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Test'
    );
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

    expect(input).not.toBeNull();
    expect(testButton).toBeDefined();
    expect(testButton?.disabled).toBe(true);

    flushSync(() => {
      setInputValue?.call(input, 'code-insiders {workspace}');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(testButton?.disabled).toBe(false);

    flushSync(() => {
      testButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.testCustomCommandMutate).toHaveBeenCalledWith({
      customCommand: 'code-insiders {workspace}',
    });

    root.unmount();
  });
});
