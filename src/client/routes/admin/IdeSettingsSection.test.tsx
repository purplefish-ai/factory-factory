// @vitest-environment jsdom

import { act, createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdeSettingsSection } from './IdeSettingsSection';

const mocks = vi.hoisted(() => ({
  updateSettingsMutate: vi.fn(),
  onSaveError: vi.fn() as (error: Error) => void,
  onSaved: (() => Promise.resolve()) as () => Promise<void>,
  onTested: (() => undefined) as () => void,
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
      update: {
        useMutation: (options: {
          onSuccess: (...args: unknown[]) => unknown;
          onError: (error: Error) => void;
        }) => {
          mocks.onSaveError = options.onError;
          mocks.onSaved = () =>
            Promise.resolve(options.onSuccess({}, { customIdeCommand: 'code {workspace}' })).then(
              () => undefined
            );
          return { mutate: mocks.updateSettingsMutate, isPending: false };
        },
      },
      testCustomCommand: {
        useMutation: (options: { onSuccess: () => void }) => {
          mocks.onTested = options.onSuccess;
          return { mutate: mocks.testCustomCommandMutate, isPending: false };
        },
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
  it('keeps IDE changes quiet and confirms only an explicit command test', async () => {
    const root = createRoot(document.createElement('div'));
    try {
      flushSync(() => root.render(createElement(IdeSettingsSection)));
      await act(async () => mocks.onSaved());
      expect(toast.success).not.toHaveBeenCalled();
      mocks.onTested();
      expect(toast.success).toHaveBeenCalledExactlyOnceWith('Command executed');
    } finally {
      flushSync(() => root.unmount());
    }
  });
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
  it('retains custom command text on failed Save and submits from the form', () => {
    mocks.userSettings.preferredIde = 'custom';
    const container = document.createElement('div');
    const root = createRoot(container);
    flushSync(() => root.render(createElement(IdeSettingsSection)));
    const input = container.querySelector<HTMLInputElement>('#custom-command');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    flushSync(() => {
      setValue?.call(input, 'code-insiders {workspace}');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    flushSync(() =>
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    );
    expect(mocks.updateSettingsMutate).toHaveBeenCalledWith({
      preferredIde: 'custom',
      customIdeCommand: 'code-insiders {workspace}',
    });
    flushSync(() => mocks.onSaveError(new Error('offline')));
    expect(input?.value).toBe('code-insiders {workspace}');
    expect(toast.error).toHaveBeenCalledWith("Couldn't update settings. offline");
    root.unmount();
  });

  it.each(['cursor', 'vscode'] as const)(
    'enters Custom from %s before saving a nonempty command',
    (preferredIde) => {
      mocks.userSettings.preferredIde = preferredIde;
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      flushSync(() => root.render(createElement(IdeSettingsSection)));
      const trigger = container.querySelector<HTMLElement>('#ide-select');
      flushSync(() => trigger?.click());
      const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
        (element) => element.textContent === 'Custom'
      );
      expect(option).toBeDefined();
      flushSync(() => option?.click());
      expect(mocks.updateSettingsMutate).not.toHaveBeenCalled();
      const input = container.querySelector<HTMLInputElement>('#custom-command');
      expect(input).not.toBeNull();
      expect(trigger?.textContent).toContain('Custom');
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      flushSync(() => {
        setValue?.call(input, '   ');
        input?.dispatchEvent(new Event('input', { bubbles: true }));
      });
      flushSync(() => input?.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
      expect(mocks.updateSettingsMutate).not.toHaveBeenCalled();
      flushSync(() => {
        setValue?.call(input, 'code-insiders {workspace}');
        input?.dispatchEvent(new Event('input', { bubbles: true }));
      });
      flushSync(() => input?.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
      expect(mocks.updateSettingsMutate).not.toHaveBeenCalled();
      const save = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Save'
      );
      flushSync(() => save?.click());
      expect(mocks.updateSettingsMutate).toHaveBeenCalledWith({
        preferredIde: 'custom',
        customIdeCommand: 'code-insiders {workspace}',
      });
      root.unmount();
    }
  );
});
