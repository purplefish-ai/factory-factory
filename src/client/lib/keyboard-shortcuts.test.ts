// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatShortcut,
  getAriaKeyShortcuts,
  getShortcut,
  isShortcutBlocked,
  matchesShortcut,
  SHORTCUTS,
  type ShortcutEnvironment,
} from './keyboard-shortcuts';

const browser: ShortcutEnvironment = { platform: 'other', runtime: 'browser' };
const desktop: ShortcutEnvironment = { platform: 'mac', runtime: 'electron' };
afterEach(() => {
  document.body.innerHTML = '';
});

describe('shortcut definitions', () => {
  it('uses unique IDs and exposes a readable description for every shortcut', () => {
    expect(new Set(SHORTCUTS.map(({ id }) => id)).size).toBe(SHORTCUTS.length);
    for (const definition of SHORTCUTS) {
      expect(definition.description.trim()).not.toBe('');
    }
  });
  it.each([
    ['p', 'composer.togglePlanMode'],
    ['t', 'composer.toggleThinking'],
    ['a', 'composer.quickActions'],
  ] as const)(
    'leaves browser Mod+Shift+%s available while preserving desktop bindings',
    (key, id) => {
      const event = new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey: true });
      expect(matchesShortcut(event, id, browser)).toBe(false);
      expect(matchesShortcut(event, id, desktop)).toBe(true);
    }
  );
  it('recognizes physical Alt chords when macOS changes the typed character', () => {
    const event = new KeyboardEvent('keydown', {
      key: '∏',
      code: 'KeyP',
      altKey: true,
      shiftKey: true,
    });
    expect(matchesShortcut(event, 'composer.togglePlanMode', browser)).toBe(true);
    expect(formatShortcut('composer.togglePlanMode', desktop)).toBe('⌥⇧P');
    expect(getAriaKeyShortcuts('composer.togglePlanMode', browser)).toBe('Alt+Shift+P');
  });
  it('requires Shift to approve and rejects command-modified review letters', () => {
    expect(
      matchesShortcut(new KeyboardEvent('keydown', { key: 'a' }), 'reviews.approve', browser)
    ).toBe(false);
    expect(
      matchesShortcut(
        new KeyboardEvent('keydown', { key: 'A', shiftKey: true }),
        'reviews.approve',
        browser
      )
    ).toBe(true);
    expect(
      matchesShortcut(
        new KeyboardEvent('keydown', { key: 'd', metaKey: true }),
        'reviews.showDiff',
        browser
      )
    ).toBe(false);
  });
  it('does not consume browser tab switching', () => {
    const event = new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true });
    expect(matchesShortcut(event, 'chat.next', browser)).toBe(false);
    expect(matchesShortcut(event, 'chat.next', desktop)).toBe(true);
  });
});

function dispatch(markup: string, options: KeyboardEventInit = {}) {
  document.body.innerHTML = markup;
  const target = document.body.firstElementChild!;
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}

describe('shortcut focus guards', () => {
  it.each(['workspace.next', 'workspace.previous', 'workspace.nextNeedsInput'] as const)(
    'leaves native paragraph navigation to text fields for %s',
    (id) => {
      expect(
        isShortcutBlocked(
          dispatch('<textarea />', { key: 'ArrowDown', altKey: true }),
          getShortcut(id)
        )
      ).toBe(true);
    }
  );
  it.each([
    '<input />',
    '<textarea />',
    '<div contenteditable="true" />',
    '<div role="combobox" />',
  ])('leaves plain keys to %s', (markup) => {
    expect(
      isShortcutBlocked(dispatch(markup, { key: '?' }), getShortcut('app.showShortcuts'))
    ).toBe(true);
  });
  it('yields to native controls, modal focus and terminal input', () => {
    document.body.innerHTML =
      '<div role="dialog"><button>Confirm</button></div><div class="xterm"><textarea /></div>';
    const button = document.querySelector('button')!;
    const event = new KeyboardEvent('keydown', { key: 'a', shiftKey: true, bubbles: true });
    button.dispatchEvent(event);
    expect(isShortcutBlocked(event, getShortcut('reviews.approve'))).toBe(true);
    const terminal = document.querySelector('.xterm')!;
    const terminalEvent = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      altKey: true,
      bubbles: true,
    });
    terminal.dispatchEvent(terminalEvent);
    expect(isShortcutBlocked(terminalEvent, getShortcut('nav.newWorkspace'))).toBe(true);
  });
  it('ignores composition, repeats and already handled keys', () => {
    expect(
      isShortcutBlocked(
        new KeyboardEvent('keydown', { isComposing: true }),
        getShortcut('app.search')
      )
    ).toBe(true);
    expect(
      isShortcutBlocked(
        new KeyboardEvent('keydown', { repeat: true }),
        getShortcut('reviews.approve')
      )
    ).toBe(true);
    const event = new KeyboardEvent('keydown', { cancelable: true });
    event.preventDefault();
    expect(isShortcutBlocked(event, getShortcut('app.search'))).toBe(true);
  });
});

it.each([
  ['<button data-review-row aria-current="true">Selected</button>', false],
  ['<button data-review-row>Other PR</button>', true],
  ['<button role="tab" data-review-tab="info">Info</button>', false],
  ['<button role="tab">Another tab</button>', true],
] as const)('scopes review action exceptions to %s', (markup, blocked) => {
  expect(
    isShortcutBlocked(
      dispatch(markup, { key: 'A', shiftKey: true }),
      getShortcut('reviews.approve')
    )
  ).toBe(blocked);
});

it('preserves Alt-bracket text entry while retaining desktop Control+Tab chat switching', () => {
  expect(
    isShortcutBlocked(
      dispatch('<textarea />', { key: '“', code: 'BracketLeft', altKey: true }),
      getShortcut('chat.previous')
    )
  ).toBe(true);
  expect(
    isShortcutBlocked(
      dispatch('<textarea />', { key: 'Tab', ctrlKey: true }),
      getShortcut('chat.next')
    )
  ).toBe(false);
});
