// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppearanceSettingsSection } from './AppearanceSettingsSection';

const mocks = vi.hoisted(() => ({
  updateSettingsMutate: vi.fn(),
  mutationOptions: null as null | { onError?: (error: Error) => void },
  setTheme: vi.fn(),
  userSettings: {
    appearanceColorScheme: 'factory',
    appearanceBackgroundColor: null as string | null,
    appearanceForegroundColor: null as string | null,
    appearanceFontScale: 100,
    appearanceFontSans: null as string | null,
    appearanceFontMono: null as string | null,
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark', resolvedTheme: 'dark', setTheme: mocks.setTheme }),
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      userSettings: { get: { invalidate: vi.fn(), setData: vi.fn() } },
    }),
    userSettings: {
      get: { useQuery: () => ({ data: mocks.userSettings, isLoading: false }) },
      update: {
        useMutation: (options: { onError?: (error: Error) => void }) => {
          mocks.mutationOptions = options;
          return { mutate: mocks.updateSettingsMutate, isPending: false };
        },
      },
    },
  },
}));

let root: Root | null = null;

function render(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root?.render(createElement(AppearanceSettingsSection));
  });
  return container;
}

function click(element: HTMLElement | null | undefined) {
  flushSync(() => {
    element?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function selectOption(container: HTMLElement, triggerId: string, optionText: string) {
  click(container.querySelector<HTMLElement>(`#${triggerId}`));
  const option = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (candidate) => candidate.textContent === optionText
  );
  expect(option, `option ${optionText}`).toBeDefined();
  click(option);
}

function typeInto(input: HTMLInputElement | null, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  flushSync(() => {
    setValue?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  flushSync(() => {
    input?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

/** Simulates dragging through the picker (one input event per color) and then leaving it. */
function pickColors(input: HTMLInputElement | null, values: string[]) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  for (const value of values) {
    flushSync(() => {
      setValue?.call(input, value);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  flushSync(() => {
    input?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

function buttonNamed(scope: ParentNode, name: string): HTMLButtonElement | undefined {
  return Array.from(scope.querySelectorAll('button')).find((button) => button.textContent === name);
}

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  vi.clearAllMocks();
  // Radix Slider measures its thumb with ResizeObserver, which jsdom lacks.
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
  // jsdom has no canvas, which the rendered-color probe needs; it falls back.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  mocks.mutationOptions = null;
  mocks.userSettings.appearanceColorScheme = 'factory';
  mocks.userSettings.appearanceBackgroundColor = null;
  mocks.userSettings.appearanceForegroundColor = null;
  mocks.userSettings.appearanceFontScale = 100;
  mocks.userSettings.appearanceFontSans = null;
  mocks.userSettings.appearanceFontMono = null;
});

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('AppearanceSettingsSection', () => {
  it('labels the font size slider thumb and announces its percentage', () => {
    const container = render();
    const thumb = container.querySelector('[role="slider"]');
    const label = document.getElementById(thumb?.getAttribute('aria-labelledby') ?? '');

    expect(thumb).not.toBeNull();
    expect(label?.textContent).toBe('Font size');
    expect(thumb?.getAttribute('aria-valuetext')).toBe('100%');
  });

  it('saves a chosen color scheme', () => {
    const container = render();
    expect(container.querySelector('#appearance-color-scheme')?.textContent).toContain('Factory');

    selectOption(container, 'appearance-color-scheme', 'GitHub');

    expect(mocks.updateSettingsMutate).toHaveBeenCalledWith({ appearanceColorScheme: 'github' });
  });

  it('switches light and dark mode through next-themes', () => {
    const container = render();
    selectOption(container, 'appearance-mode', 'Light');
    expect(mocks.setTheme).toHaveBeenCalledWith('light');
    expect(mocks.updateSettingsMutate).not.toHaveBeenCalled();
  });

  it('commits a background color on blur and clears it with Reset', () => {
    const container = render();
    const picker = container.querySelector<HTMLInputElement>('#appearance-background-color');
    expect(picker?.value).toBe('#0a0a0a');

    typeInto(picker, '#123456');
    expect(mocks.updateSettingsMutate).toHaveBeenCalledWith({
      appearanceBackgroundColor: '#123456',
    });

    root?.unmount();
    document.body.innerHTML = '';
    mocks.updateSettingsMutate.mockClear();
    mocks.userSettings.appearanceBackgroundColor = '#123456';
    const rerendered = render();
    const field = rerendered
      .querySelector('#appearance-background-color')
      ?.closest('.space-y-1\\.5') as HTMLElement;
    expect(field.textContent).toContain('#123456');
    click(buttonNamed(field, 'Reset'));
    expect(mocks.updateSettingsMutate).toHaveBeenCalledWith({ appearanceBackgroundColor: null });
  });

  it('saves the placeholder color when it is picked deliberately', () => {
    const container = render();
    const picker = container.querySelector<HTMLInputElement>('#appearance-background-color');
    expect(picker?.value).toBe('#0a0a0a');
    pickColors(picker, ['#123456', '#0a0a0a']);
    expect(mocks.updateSettingsMutate).toHaveBeenCalledWith({
      appearanceBackgroundColor: '#0a0a0a',
    });
  });

  it('keeps an in-progress pick when the placeholder changes underneath it', () => {
    const container = render();
    const picker = container.querySelector<HTMLInputElement>('#appearance-background-color');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    flushSync(() => {
      setValue?.call(picker, '#123456');
      picker?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // The painted scheme color is re-read whenever <html> changes.
    flushSync(() => {
      document.documentElement.classList.toggle('dark');
    });

    flushSync(() => {
      picker?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(mocks.updateSettingsMutate).toHaveBeenCalledWith({
      appearanceBackgroundColor: '#123456',
    });
  });

  it('does not save when the picker is left on its placeholder', () => {
    const container = render();
    const picker = container.querySelector<HTMLInputElement>('#appearance-foreground-color');
    flushSync(() => {
      picker?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(mocks.updateSettingsMutate).not.toHaveBeenCalled();
  });

  it('resets the font scale to the default', () => {
    mocks.userSettings.appearanceFontScale = 125;
    const container = render();
    expect(container.textContent).toContain('125%');

    const field = container
      .querySelector('#appearance-font-scale')
      ?.closest('.space-y-1\\.5') as HTMLElement;
    click(buttonNamed(field, 'Reset'));

    expect(mocks.updateSettingsMutate).toHaveBeenCalledWith({ appearanceFontScale: 100 });
  });

  it('saves a preset monospace font', () => {
    const container = render();
    selectOption(container, 'appearance-font-mono', 'IBM Plex Mono');
    expect(mocks.updateSettingsMutate).toHaveBeenCalledWith({
      appearanceFontMono: '"IBM Plex Mono", ui-monospace, monospace',
    });
  });

  it('saves a valid custom font and rejects an invalid one', () => {
    const container = render();
    selectOption(container, 'appearance-font-sans', 'Custom…');
    expect(mocks.updateSettingsMutate).not.toHaveBeenCalled();

    const input = container.querySelector<HTMLInputElement>('#appearance-font-sans-custom');
    expect(input).not.toBeNull();

    typeInto(input, 'OpenDyslexic, sans-serif');
    expect(mocks.updateSettingsMutate).toHaveBeenCalledWith({
      appearanceFontSans: 'OpenDyslexic, sans-serif',
    });

    mocks.updateSettingsMutate.mockClear();
    typeInto(input, 'Inter; background: url(x)');
    expect(mocks.updateSettingsMutate).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Font family');
  });

  it('returns the font selector to the saved font when the save fails', () => {
    const container = render();
    selectOption(container, 'appearance-font-mono', 'IBM Plex Mono');
    expect(container.querySelector('#appearance-font-mono')?.textContent).toContain(
      'IBM Plex Mono'
    );

    flushSync(() => {
      mocks.mutationOptions?.onError?.(new Error('offline'));
    });

    expect(container.querySelector('#appearance-font-mono')?.textContent).toContain(
      'Geist Mono (default)'
    );
  });

  it('returns the font scale draft to the saved value when the save fails', () => {
    const container = render();
    const slider = container.querySelector<HTMLElement>('#appearance-font-scale [role="slider"]');
    flushSync(() => {
      slider?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(container.textContent).toContain('105%');

    flushSync(() => {
      mocks.mutationOptions?.onError?.(new Error('offline'));
    });

    expect(container.textContent).toContain('100%');
    expect(container.textContent).not.toContain('105%');
  });

  it('shows a saved custom font as Custom with its value', () => {
    mocks.userSettings.appearanceFontMono = 'Fira Code';
    const container = render();
    expect(container.querySelector('#appearance-font-mono')?.textContent).toContain('Custom');
    expect(container.querySelector<HTMLInputElement>('#appearance-font-mono-custom')?.value).toBe(
      'Fira Code'
    );
  });

  it('resets every appearance preference at once', () => {
    mocks.userSettings.appearanceColorScheme = 'solarized';
    mocks.userSettings.appearanceFontScale = 150;
    const container = render();

    click(buttonNamed(container, 'Reset appearance'));

    expect(mocks.updateSettingsMutate).toHaveBeenCalledWith({
      appearanceColorScheme: 'factory',
      appearanceBackgroundColor: null,
      appearanceForegroundColor: null,
      appearanceFontScale: 100,
      appearanceFontSans: null,
      appearanceFontMono: null,
    });
  });

  it('disables Reset appearance while everything is default', () => {
    const container = render();
    expect(buttonNamed(container, 'Reset appearance')?.disabled).toBe(true);
  });
});
