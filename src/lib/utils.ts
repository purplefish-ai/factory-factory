import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Duration in milliseconds for which a push is considered "recent" for ratcheting animation.
 */
export const RATCHET_PUSH_DURATION_MS = 60_000; // 60 seconds

/**
 * Duration in milliseconds for the waiting pulse animation.
 */
export const WAITING_PULSE_DURATION_MS = 30_000; // 30 seconds

/**
 * Check if a push happened within the ratcheting animation window.
 * Used to show temporary ratcheting animation after a git push.
 */
export function isRecentPush(pushTime: string | Date | null | undefined): boolean {
  if (!pushTime) {
    return false;
  }
  const ms = pushTime instanceof Date ? pushTime.getTime() : new Date(pushTime).getTime();
  if (!Number.isFinite(ms)) {
    return false;
  }
  return Date.now() - ms < RATCHET_PUSH_DURATION_MS;
}

/**
 * Check if ratchet state indicates an active ratcheting process.
 */
export function isRatchetStateActive(ratchetState: string | null | undefined): boolean {
  return Boolean(ratchetState && ratchetState !== 'IDLE' && ratchetState !== 'READY');
}

/**
 * Check if ratcheting animation should be shown.
 * Animation shows when ratchet state is active OR a push happened recently.
 */
export function shouldShowRatchetAnimation(
  ratchetState: string | null | undefined,
  lastPushAt: string | Date | null | undefined
): boolean {
  return isRatchetStateActive(ratchetState) || isRecentPush(lastPushAt);
}

/**
 * Check if a timestamp is within the waiting pulse window.
 * Used to show temporary pulse animation when workspace enters WAITING state.
 */
export function isWithinWaitingWindow(timestamp: string | Date | null | undefined): boolean {
  if (!timestamp) {
    return false;
  }
  const ms = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
  if (!Number.isFinite(ms)) {
    return false;
  }
  return Date.now() - ms < WAITING_PULSE_DURATION_MS;
}

/**
 * Format a date as a relative time string (e.g., "2m", "1h", "3d")
 */
export function formatRelativeTime(date: string | Date | null | undefined): string {
  if (!date) {
    return '';
  }
  const ms = new Date(date).getTime();
  if (!Number.isFinite(ms)) {
    return '';
  }
  const seconds = Math.floor((Date.now() - ms) / 1000);
  // Future dates or very recent: show "now"
  if (seconds < 60) {
    return 'now';
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)}h`;
  }
  return `${Math.floor(seconds / 86_400)}d`;
}
