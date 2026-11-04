import { z } from 'zod';

export const BROWSER_NOTIFICATIONS_KEY = 'factoryfactory_browser_notifications_enabled';
const PREFERENCE_CHANGED = 'browser-notification-preference-changed';

/** Device-local opt-in. Existing browser permission alone never opts a user in. */
export function readBrowserNotificationsEnabled(): boolean {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(BROWSER_NOTIFICATIONS_KEY) ?? 'false');
    const result = z.boolean().safeParse(value);
    return result.success ? result.data : false;
  } catch {
    return false;
  }
}

/** Storage failures are surfaced by the Settings action, leaving the switch off. */
export function writeBrowserNotificationsEnabled(enabled: boolean): void {
  localStorage.setItem(BROWSER_NOTIFICATIONS_KEY, JSON.stringify(enabled));
  window.dispatchEvent(new Event(PREFERENCE_CHANGED));
}

export function subscribeBrowserNotifications(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === BROWSER_NOTIFICATIONS_KEY || event.key === null) {
      listener();
    }
  };
  window.addEventListener(PREFERENCE_CHANGED, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(PREFERENCE_CHANGED, listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function readNotificationPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}
