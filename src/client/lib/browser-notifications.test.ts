// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  BROWSER_NOTIFICATIONS_KEY,
  readBrowserNotificationsEnabled,
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
it('stores the preference as JSON and throws when storage refuses it', () => {
  writeBrowserNotificationsEnabled(true);
  expect(localStorage.getItem(BROWSER_NOTIFICATIONS_KEY)).toBe('true');
  expect(readBrowserNotificationsEnabled()).toBe(true);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Denied');
  });
  expect(() => writeBrowserNotificationsEnabled(false)).toThrow();
  expect(readBrowserNotificationsEnabled()).toBe(true);
});
