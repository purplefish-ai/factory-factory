import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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
