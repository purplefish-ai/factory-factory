// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { setShortcutEnvironmentForTesting } from '@/client/lib/keyboard-shortcuts';
import { hasShortcutHandler, registerShortcutHandler, triggerShortcut } from './shortcut-registry';
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  setShortcutEnvironmentForTesting(null);
  document.body.innerHTML = '';
});
function key(options: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options });
  (document.body.firstElementChild ?? window).dispatchEvent(event);
  return event;
}
it('routes keyboard and command palette through the same current handler and restores previous owners', () => {
  setShortcutEnvironmentForTesting({ platform: 'other', runtime: 'browser' });
  const outer = vi.fn();
  const inner = vi.fn();
  cleanups.push(registerShortcutHandler('app.search', outer));
  const removeInner = registerShortcutHandler('app.search', inner);
  cleanups.push(removeInner);
  expect(key({ key: 'k', ctrlKey: true }).defaultPrevented).toBe(true);
  expect(inner).toHaveBeenCalledTimes(1);
  expect(outer).not.toHaveBeenCalled();
  expect(triggerShortcut('app.search')).toBe(true);
  expect(inner).toHaveBeenCalledTimes(2);
  removeInner();
  expect(triggerShortcut('app.search')).toBe(true);
  expect(outer).toHaveBeenCalledTimes(1);
});
it('does not swallow keys when an action declines or after its owner unmounts', () => {
  const remove = registerShortcutHandler('workspace.next', () => false);
  cleanups.push(remove);
  expect(key({ key: 'ArrowDown', altKey: true }).defaultPrevented).toBe(false);
  remove();
  expect(hasShortcutHandler('workspace.next')).toBe(false);
  expect(triggerShortcut('workspace.next')).toBe(false);
});
it('does not approve while typing or when a dialog owns focus', () => {
  const approve = vi.fn();
  cleanups.push(registerShortcutHandler('reviews.approve', approve));
  document.body.innerHTML = '<textarea />';
  key({ key: 'A', shiftKey: true });
  document.body.innerHTML = '<div role="alertdialog"><button>Cancel</button></div>';
  key({ key: 'A', shiftKey: true });
  expect(approve).not.toHaveBeenCalled();
});

it('cleans up the exact registration when the same handler is registered twice', () => {
  const same = vi.fn();
  const middle = vi.fn();
  const first = registerShortcutHandler('app.search', same);
  cleanups.push(first);
  cleanups.push(registerShortcutHandler('app.search', middle));
  cleanups.push(registerShortcutHandler('app.search', same));
  first();
  triggerShortcut('app.search');
  expect(same).toHaveBeenCalledTimes(1);
  expect(middle).not.toHaveBeenCalled();
});
it('exposes and runs only currently actionable registered commands', () => {
  let visible = false;
  const focus = vi.fn();
  cleanups.push(registerShortcutHandler('chat.focusComposer', focus, () => visible));
  expect(hasShortcutHandler('chat.focusComposer')).toBe(false);
  expect(triggerShortcut('chat.focusComposer')).toBe(false);
  expect(focus).not.toHaveBeenCalled();
  visible = true;
  expect(hasShortcutHandler('chat.focusComposer')).toBe(true);
  expect(triggerShortcut('chat.focusComposer')).toBe(true);
  expect(focus).toHaveBeenCalledOnce();
});

it('lets a visible outer composer own a shortcut while a later composer is hidden', () => {
  const outer = vi.fn();
  const hidden = vi.fn();
  cleanups.push(registerShortcutHandler('chat.focusComposer', outer));
  cleanups.push(registerShortcutHandler('chat.focusComposer', hidden, () => false));
  expect(triggerShortcut('chat.focusComposer')).toBe(true);
  expect(outer).toHaveBeenCalledOnce();
  expect(hidden).not.toHaveBeenCalled();
});
