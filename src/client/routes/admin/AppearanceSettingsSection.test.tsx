// @vitest-environment jsdom

import { act, createElement } from 'react';
import { flushSync } from 'react-dom';
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
import { AppearanceSettingsSection } from './AppearanceSettingsSection';

const mocks = vi.hoisted(() => ({ setTheme: vi.fn() }));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));
vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark', resolvedTheme: 'dark', setTheme: mocks.setTheme }),
}));

let server: SettingsServer;
let view: RenderedSettings | undefined;

async function render(options: SettingsServerOptions = {}): Promise<HTMLElement> {
  server = createSettingsServer(options);
  view = await renderWithSettingsServer(createElement(AppearanceSettingsSection), server);
  return view.container;
}

const updates = () =>
  server.requests.filter(({ path }) => path === 'userSettings.update').map(({ input }) => input);

function click(element: HTMLElement | null | undefined) {
  flushSync(() => {
    element?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
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

beforeEach(() => {
  vi.clearAllMocks();
  stubRadixLayout();
  // jsdom has no canvas, which the rendered-color probe needs; it falls back.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(async () => {
  await view?.unmount();
  view = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AppearanceSettingsSection', () => {
  it('labels the font size slider thumb and announces its percentage', async () => {
    const container = await render();
    const thumb = container.querySelector('[role="slider"]');
    const label = document.getElementById(thumb?.getAttribute('aria-labelledby') ?? '');

    expect(thumb).not.toBeNull();
    expect(label?.textContent).toBe('Font size');
    expect(thumb?.getAttribute('aria-valuetext')).toBe('100%');
  });

  it('saves a chosen color scheme', async () => {
    const container = await render();
    expect(container.querySelector('#appearance-color-scheme')?.textContent).toContain('Factory');

    await chooseOption(container, 'appearance-color-scheme', 'GitHub');

    expect(container.querySelector('#appearance-color-scheme')?.textContent).toContain('GitHub');
    await waitForCheck(() => expect(updates()).toEqual([{ appearanceColorScheme: 'github' }]));
  });

  it('switches light and dark mode through next-themes', async () => {
    const container = await render();
    await chooseOption(container, 'appearance-mode', 'Light');
    expect(mocks.setTheme).toHaveBeenCalledWith('light');
    expect(updates()).toEqual([]);
  });

  it('commits a background color on blur and clears it with Reset', async () => {
    const container = await render();
    const picker = container.querySelector<HTMLInputElement>('#appearance-background-color');
    expect(picker?.value).toBe('#0a0a0a');

    typeInto(picker, '#123456');
    const field = picker?.closest('.space-y-2') as HTMLElement;
    await waitForCheck(() => expect(field.textContent).toContain('#123456'));
    expect(updates()).toEqual([{ appearanceBackgroundColor: '#123456' }]);

    click(buttonNamed(field, 'Reset'));
    await waitForCheck(() => expect(field.textContent).toContain('From color scheme'));
    expect(updates()).toEqual([
      { appearanceBackgroundColor: '#123456' },
      { appearanceBackgroundColor: null },
    ]);
  });

  it('saves the placeholder color when it is picked deliberately', async () => {
    const container = await render();
    const picker = container.querySelector<HTMLInputElement>('#appearance-background-color');
    expect(picker?.value).toBe('#0a0a0a');
    pickColors(picker, ['#123456', '#0a0a0a']);
    await waitForCheck(() => expect(updates()).toEqual([{ appearanceBackgroundColor: '#0a0a0a' }]));
  });

  it('keeps an in-progress pick when the placeholder changes underneath it', async () => {
    const container = await render();
    const picker = container.querySelector<HTMLInputElement>('#appearance-background-color');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    flushSync(() => {
      setValue?.call(picker, '#123456');
      picker?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // The painted scheme color is re-read whenever <html> changes.
    await act(() => {
      document.documentElement.classList.toggle('dark');
    });

    flushSync(() => {
      picker?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    await waitForCheck(() => expect(updates()).toEqual([{ appearanceBackgroundColor: '#123456' }]));
  });

  it('does not save when the picker is left on its placeholder', async () => {
    const container = await render();
    const picker = container.querySelector<HTMLInputElement>('#appearance-foreground-color');
    flushSync(() => {
      picker?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(updates()).toEqual([]);
  });

  it('resets the font scale to the default', async () => {
    const container = await render({ settings: { appearanceFontScale: 125 } });
    expect(container.textContent).toContain('125%');

    const field = container.querySelector('#appearance-font-scale')?.closest('.space-y-2');
    click(buttonNamed(field as HTMLElement, 'Reset'));

    await waitForCheck(() => expect(updates()).toEqual([{ appearanceFontScale: 100 }]));
    expect(container.textContent).toContain('100%');
  });

  it('saves a preset monospace font', async () => {
    const container = await render();
    await chooseOption(container, 'appearance-font-mono', 'IBM Plex Mono');
    await waitForCheck(() =>
      expect(updates()).toEqual([
        { appearanceFontMono: '"IBM Plex Mono", ui-monospace, monospace' },
      ])
    );
  });

  it('saves a valid custom font and rejects an invalid one', async () => {
    const container = await render();
    await chooseOption(container, 'appearance-font-sans', 'Custom…');
    expect(updates()).toEqual([]);

    const input = container.querySelector<HTMLInputElement>('#appearance-font-sans-custom');
    expect(input).not.toBeNull();

    typeInto(input, 'OpenDyslexic, sans-serif');
    expect(updates()).toEqual([]);
    flushSync(() =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Save interface font"]')
        ?.click()
    );
    await waitForCheck(() =>
      expect(updates()).toEqual([{ appearanceFontSans: 'OpenDyslexic, sans-serif' }])
    );

    typeInto(input, 'Inter; background: url(x)');
    flushSync(() =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Save interface font"]')
        ?.click()
    );
    expect(updates()).toHaveLength(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Font family');
  });

  it('retains a custom-font draft after a save failure for retry', async () => {
    const container = await render();
    server.failUpdates = 'offline';
    await chooseOption(container, 'appearance-font-sans', 'Custom…');
    const input = container.querySelector<HTMLInputElement>('#appearance-font-sans-custom');
    typeInto(input, 'OpenDyslexic, sans-serif');
    flushSync(() =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Save interface font"]')
        ?.click()
    );
    await waitForCheck(() =>
      expect(updates()).toEqual([{ appearanceFontSans: 'OpenDyslexic, sans-serif' }])
    );
    await waitForCheck(() => expect(container.querySelector('[aria-label="Saving"]')).toBeNull());
    expect(container.querySelector<HTMLInputElement>('#appearance-font-sans-custom')?.value).toBe(
      'OpenDyslexic, sans-serif'
    );
  });

  it('only marks the setting being saved as saving', async () => {
    const container = await render({
      settings: { appearanceFontSans: 'OpenDyslexic, sans-serif' },
      hold: ['userSettings.update'],
    });
    await chooseOption(container, 'appearance-color-scheme', 'GitHub');
    await waitForCheck(() => expect(server.held).toHaveLength(1));
    const save = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Save interface font"]'
    );
    expect(save?.disabled).toBe(false);
    expect(save?.textContent).toBe('Save');
    const saving = container.querySelectorAll('[aria-label="Saving"]');
    expect(saving).toHaveLength(1);
    expect(saving[0]?.closest('.space-y-2')?.textContent).toContain('Color scheme');
  });

  it('returns the font selector to the saved font when the save fails', async () => {
    const container = await render({ hold: ['userSettings.update'] });
    await chooseOption(container, 'appearance-font-mono', 'IBM Plex Mono');
    expect(container.querySelector('#appearance-font-mono')?.textContent).toContain(
      'IBM Plex Mono'
    );

    await waitForCheck(() => expect(server.held).toHaveLength(1));
    await act(async () => server.held[0]?.reject('offline'));

    await waitForCheck(() =>
      expect(container.querySelector('#appearance-font-mono')?.textContent).toContain(
        'Geist Mono (default)'
      )
    );
  });

  it('returns the font scale to the saved value when the save fails', async () => {
    const container = await render({ hold: ['userSettings.update'] });
    const slider = container.querySelector<HTMLElement>('#appearance-font-scale [role="slider"]');
    await act(() => {
      slider?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(container.textContent).toContain('105%');

    await waitForCheck(() => expect(server.held).toHaveLength(1));
    await act(async () => server.held[0]?.reject('offline'));

    await waitForCheck(() => expect(container.textContent).toContain('100%'));
    expect(container.textContent).not.toContain('105%');
  });

  it('shows a saved custom font as Custom with its value', async () => {
    const container = await render({ settings: { appearanceFontMono: 'Fira Code' } });
    expect(container.querySelector('#appearance-font-mono')?.textContent).toContain('Custom');
    expect(container.querySelector<HTMLInputElement>('#appearance-font-mono-custom')?.value).toBe(
      'Fira Code'
    );
  });

  it('resets every appearance preference at once', async () => {
    const container = await render({
      settings: { appearanceColorScheme: 'solarized', appearanceFontScale: 150 },
    });

    click(buttonNamed(container, 'Reset appearance'));

    await waitForCheck(() =>
      expect(updates()).toEqual([
        {
          appearanceColorScheme: 'factory',
          appearanceBackgroundColor: null,
          appearanceForegroundColor: null,
          appearanceFontScale: 100,
          appearanceFontSans: null,
          appearanceFontMono: null,
        },
      ])
    );
    await waitForCheck(() =>
      expect(buttonNamed(container, 'Reset appearance')?.disabled).toBe(true)
    );
  });

  it('disables Reset appearance while everything is default', async () => {
    const container = await render();
    expect(buttonNamed(container, 'Reset appearance')?.disabled).toBe(true);
  });
});
