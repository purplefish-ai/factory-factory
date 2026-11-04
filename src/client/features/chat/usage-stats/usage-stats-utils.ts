import {
  CONTEXT_CRITICAL_THRESHOLD,
  CONTEXT_WARNING_THRESHOLD,
  type TokenStats,
} from '@/lib/chat-protocol';

/**
 * Calculates context window usage percentage.
 * Returns 0 if context window is not available.
 */
export function calculateContextUsagePercentage(stats: TokenStats): number {
  if (!stats.contextWindow || stats.contextUsedTokens == null) {
    return 0;
  }
  const usedTokens = stats.contextUsedTokens;
  return Math.min((usedTokens / stats.contextWindow) * 100, 100);
}

/**
 * Gets the text color class based on usage percentage.
 */
export function getUsageColorClass(
  percentage: number | null,
  warningClass = 'text-warning'
): string {
  if (percentage === null) {
    return 'text-muted-foreground';
  }
  if (percentage >= CONTEXT_CRITICAL_THRESHOLD * 100) {
    return 'text-destructive';
  }
  if (percentage >= CONTEXT_WARNING_THRESHOLD * 100) {
    return warningClass;
  }
  return 'text-muted-foreground';
}

/**
 * Gets the progress bar color class based on usage percentage.
 */
export function getProgressColorClass(percentage: number): string {
  if (percentage >= CONTEXT_CRITICAL_THRESHOLD * 100) {
    return '[&>div]:bg-destructive';
  }
  if (percentage >= CONTEXT_WARNING_THRESHOLD * 100) {
    return '[&>div]:bg-warning';
  }
  return '[&>div]:bg-success';
}
