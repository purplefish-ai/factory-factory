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
