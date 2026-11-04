// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  BROWSER_NOTIFICATIONS_KEY,
  readBrowserNotificationsEnabled,
  subscribeBrowserNotifications,
  writeBrowserNotificationsEnabled,
} from './browser-notifications';
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
it.each(['garbage', '"true"', 'null', '{}', '1', 'false'])(
  'defaults off for invalid/non-enabled persisted values: %s',
  (value) => {
    localStorage.setItem(BROWSER_NOTIFICATIONS_KEY, value);
    expect(readBrowserNotificationsEnabled()).toBe(false);
  }
);
it('reads safely when storage is unavailable', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('Denied');
  });
  expect(readBrowserNotificationsEnabled()).toBe(false);
});
it('notifies same-window writes, relevant other-tab changes and clearing storage only', () => {
  const listener = vi.fn();
  const unsubscribe = subscribeBrowserNotifications(listener);
  writeBrowserNotificationsEnabled(true);
  expect(listener).toHaveBeenCalledOnce();
  window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }));
  expect(listener).toHaveBeenCalledOnce();
  window.dispatchEvent(new StorageEvent('storage', { key: BROWSER_NOTIFICATIONS_KEY }));
  window.dispatchEvent(new StorageEvent('storage', { key: null }));
  expect(listener).toHaveBeenCalledTimes(3);
  unsubscribe();
  writeBrowserNotificationsEnabled(false);
  expect(listener).toHaveBeenCalledTimes(3);
});
