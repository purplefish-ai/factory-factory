interface FormatBytesOptions {
  /** Decimal places for scaled units; bytes remain unrounded. */
  precision?: number;
}

/**
 * Format nonnegative byte counts using binary (1024) thresholds and B/KB/MB/GB
 * labels. GB is the largest unit, including for terabyte-sized values.
 * Null and undefined display as "-"; zero displays as "0 B".
 *
 * Defaults preserve admin memory precision: one decimal for KB/MB, two for GB.
 * File previews and upload errors pass { precision: 1 } for compact labels.
 * Units are selected before rounding, so a value just below 1 MB can show
 * "1024.0 KB". Precision follows Number.toFixed's supported range (0–100).
 */
export function formatBytes(
  bytes: number | null | undefined,
  { precision }: FormatBytesOptions = {}
): string {
  if (bytes === null || bytes === undefined) {
    return '-';
  }
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  let unit = 0;
  let value = bytes;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) {
    return `${bytes} B`;
  }
  return `${value.toFixed(precision ?? (unit === 3 ? 2 : 1))} ${units[unit]}`;
}

/**
 * Format CPU percentage
 */
export function formatCpu(cpu: number | null | undefined): string {
  if (cpu === null || cpu === undefined) {
    return '-';
  }
  return `${cpu.toFixed(1)}%`;
}

/**
 * Format idle time in milliseconds to human-readable string (ms, s, m)
 */
export function formatIdleTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) {
    return '-';
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(0)}s`;
  }
  return `${(ms / 60_000).toFixed(1)}m`;
}

/**
 * Format a date string as absolute date and time (e.g., "Jan 15, 2:30 PM").
 * Used for comment timestamps and detailed views.
 */
export function formatDateTimeShort(dateStr: string): string {
  const date = new Date(dateStr);
  // Formatting an invalid Date returns "Invalid Date" rather than throwing.
  if (Number.isNaN(date.getTime())) {
    return dateStr;
  }
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
