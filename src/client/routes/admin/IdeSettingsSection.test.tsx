// @vitest-environment jsdom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chooseOption,
  createSettingsServer,
  type RenderedSettings,
  renderWithSettingsServer,
  type SettingsServer,
  type SettingsServerOptions,
  stubRadixLayout,
} from '@/client/lib/user-settings-queries.test-harness';
import { waitForCheck } from '@/test-utils/react-act';
import { IdeSettingsSection } from './IdeSettingsSection';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

let server: SettingsServer;
let view: RenderedSettings | undefined;
const testCustomCommand = vi.fn(() => ({ success: true }));

async function render(options: SettingsServerOptions = {}) {
  server = createSettingsServer({
    ...options,
    handlers: { 'userSettings.testCustomCommand': testCustomCommand },
  });
  view = await renderWithSettingsServer(createElement(IdeSettingsSection), server);
  return view.container;
}

const updates = () =>
  server.requests.filter(({ path }) => path === 'userSettings.update').map(({ input }) => input);

function typeInto(input: HTMLInputElement | null, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setValue?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function button(container: HTMLElement, name: string) {
  return Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === name
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  stubRadixLayout();
});
afterEach(async () => {
  await view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

describe('IdeSettingsSection', () => {
  it('keeps IDE changes quiet and confirms only an explicit command test', async () => {
    const container = await render({
      settings: { preferredIde: 'custom', customIdeCommand: 'code {workspace}' },
    });
    await chooseOption(container, 'ide-select', 'VS Code');
    await waitForCheck(() => expect(updates()).toEqual([{ preferredIde: 'vscode' }]));
    expect(toast.success).not.toHaveBeenCalled();

    await chooseOption(container, 'ide-select', 'Custom');
    await act(async () => button(container, 'Test')?.click());
    await waitForCheck(() =>
      expect(toast.success).toHaveBeenCalledExactlyOnceWith('Command executed')
    );
    expect(testCustomCommand).toHaveBeenCalledWith({ customCommand: 'code {workspace}' });
  });

  it('preserves the saved custom command when switching to a built-in IDE', async () => {
    const container = await render({
      settings: { preferredIde: 'custom', customIdeCommand: 'code-insiders {workspace}' },
    });
    await chooseOption(container, 'ide-select', 'Cursor');
    await waitForCheck(() => expect(updates()).toEqual([{ preferredIde: 'cursor' }]));
    expect(container.querySelector('#custom-command')).toBeNull();
    expect(server.settings.customIdeCommand).toBe('code-insiders {workspace}');
  });

  it('autosaves Custom mode with the saved command while preserving an unsaved draft', async () => {
    const container = await render({
      settings: { preferredIde: 'custom', customIdeCommand: 'saved {workspace}' },
      hold: ['userSettings.update'],
    });
    typeInto(container.querySelector<HTMLInputElement>('#custom-command'), 'draft {workspace}');
    await chooseOption(container, 'ide-select', 'Cursor');
    await waitForCheck(() => expect(server.held).toHaveLength(1));
    await act(async () => server.held[0]?.respond());
    await chooseOption(container, 'ide-select', 'Custom');
    await waitForCheck(() => expect(server.held).toHaveLength(2));
    expect(server.held[1]?.input).toEqual({
      preferredIde: 'custom',
      customIdeCommand: 'saved {workspace}',
    });
    expect(container.querySelector<HTMLInputElement>('#custom-command')?.value).toBe(
      'draft {workspace}'
    );
  });

  it('tests the current custom command before it has been saved', async () => {
    const container = await render({ settings: { preferredIde: 'custom' } });
    const input = container.querySelector<HTMLInputElement>('#custom-command');
    expect(input).not.toBeNull();
    expect(button(container, 'Test')?.disabled).toBe(true);

    typeInto(input, 'code-insiders {workspace}');
    expect(button(container, 'Test')?.disabled).toBe(false);
    await act(async () => button(container, 'Test')?.click());

    await waitForCheck(() =>
      expect(testCustomCommand).toHaveBeenCalledWith({ customCommand: 'code-insiders {workspace}' })
    );
    expect(updates()).toEqual([]);
  });

  it('retains custom command text on failed Save and submits from the form', async () => {
    const container = await render({ settings: { preferredIde: 'custom' } });
    server.failUpdates = 'offline';
    const input = container.querySelector<HTMLInputElement>('#custom-command');
    typeInto(input, 'code-insiders {workspace}');
    await act(async () =>
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    );
    await waitForCheck(() =>
      expect(updates()).toEqual([
        { preferredIde: 'custom', customIdeCommand: 'code-insiders {workspace}' },
      ])
    );
    await waitForCheck(() => expect(button(container, 'Save')?.disabled).toBe(false));
    expect(input?.value).toBe('code-insiders {workspace}');
  });

  it.each(['cursor', 'vscode'])(
    'enters Custom from %s before saving a nonempty command',
    async (preferredIde) => {
      const container = await render({ settings: { preferredIde } });
      await chooseOption(container, 'ide-select', 'Custom');
      expect(updates()).toEqual([]);
      expect(container.querySelector('#ide-select')?.textContent).toContain('Custom');

      const input = container.querySelector<HTMLInputElement>('#custom-command');
      typeInto(input, '   ');
      expect(button(container, 'Save')?.disabled).toBe(true);
      typeInto(input, 'code-insiders {workspace}');
      act(() => {
        input?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });
      expect(updates()).toEqual([]);

      await act(async () => button(container, 'Save')?.click());
      await waitForCheck(() =>
        expect(updates()).toEqual([
          { preferredIde: 'custom', customIdeCommand: 'code-insiders {workspace}' },
        ])
      );
      expect(container.querySelector('#ide-select')?.textContent).toContain('Custom');
    }
  );
});
