/**
 * Format bytes to human-readable string (B, KB, MB, GB)
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) {
    return '-';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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
 * Format a date string as relative time (compact: "Xm ago", "Xh ago", "Xd ago")
 * or absolute date for older dates (e.g., "Jan 15").
 * Used for session timestamps where space is limited.
 */
export function formatRelativeDateShort(dateString: string): string {
  try {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60_000);
    const diffHours = Math.floor(diffMs / 3_600_000);
    const diffDays = Math.floor(diffMs / 86_400_000);

    if (diffMins < 1) {
      return 'Just now';
    }
    if (diffMins < 60) {
      return `${diffMins}m ago`;
    }
    if (diffHours < 24) {
      return `${diffHours}h ago`;
    }
    if (diffDays < 7) {
      return `${diffDays}d ago`;
    }

    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    // Invalid date string - return as-is rather than crashing
    return dateString;
  }
}

/**
 * Format a date string as relative time (friendly: "today", "yesterday", "X days ago")
 * or absolute date for older dates.
 * Used for issue timestamps where readability is prioritized.
 */
export function formatRelativeDateFriendly(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return 'today';
  }
  if (diffDays === 1) {
    return 'yesterday';
  }
  if (diffDays < 7) {
    return `${diffDays} days ago`;
  }
  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`;
  }
  return date.toLocaleDateString();
}

/**
 * Format a date string as absolute date and time (e.g., "Jan 15, 2:30 PM").
 * Used for comment timestamps and detailed views.
 */
export function formatDateTimeShort(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
