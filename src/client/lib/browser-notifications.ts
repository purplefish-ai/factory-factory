import { z } from 'zod';
import { readStoredJson, writeStoredJson } from '@/client/lib/browser-storage';

export const BROWSER_NOTIFICATIONS_KEY = 'factoryfactory_browser_notifications_enabled';
export const BrowserNotificationsEnabledSchema = z.boolean();

/** Device-local opt-in. Existing browser permission alone never opts a user in. */
export function readBrowserNotificationsEnabled(): boolean {
  return readStoredJson(BROWSER_NOTIFICATIONS_KEY, BrowserNotificationsEnabledSchema) ?? false;
}

/**
 * Throws when storage refuses the preference, so the Settings action can
 * report it and leave the switch unchanged. Mounted readers update on success.
 */
export function writeBrowserNotificationsEnabled(enabled: boolean): void {
  if (!writeStoredJson(BROWSER_NOTIFICATIONS_KEY, enabled)) {
    throw new Error("Couldn't save the browser notification preference.");
  }
}

export function readNotificationPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}
