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
