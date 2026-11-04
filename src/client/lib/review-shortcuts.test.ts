// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { getReviewShortcut } from './review-shortcuts';

function keydown(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  let shortcut: string | null | undefined;
  window.addEventListener('keydown', (event) => (shortcut = getReviewShortcut(event)), {
    once: true,
  });
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  return shortcut;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('getReviewShortcut', () => {
  it('returns plain keys and normalizes Shift chords', () => {
    expect(keydown(document.body, 'j')).toBe('j');
    expect(keydown(document.body, 'A', { shiftKey: true })).toBe('Shift+A');
    expect(keydown(document.body, 'a', { shiftKey: true })).toBe('Shift+A');
    // Caps Lock without Shift is not the approval chord.
    expect(keydown(document.body, 'A')).toBe('A');
  });

  it.each([
    ['meta', { metaKey: true }],
    ['ctrl', { ctrlKey: true }],
    ['alt', { altKey: true }],
  ])('ignores %s-modified keys', (_label, init) => {
    expect(keydown(document.body, 'd', init)).toBeNull();
  });

  it('ignores text fields and unrelated buttons but not review rows', () => {
    const input = document.createElement('input');
    const button = document.createElement('button');
    const list = document.createElement('div');
    list.setAttribute('data-review-list', '');
    const row = document.createElement('button');
    list.append(row);
    document.body.append(input, button, list);

    expect(keydown(input, 'd')).toBeNull();
    expect(keydown(button, 'd')).toBeNull();
    expect(keydown(row, 'd')).toBe('d');
  });
});
