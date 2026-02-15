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
  if (!stats.contextWindow || stats.contextWindow === 0) {
    return 0;
  }
  const usedTokens = stats.inputTokens + stats.outputTokens;
  return Math.min((usedTokens / stats.contextWindow) * 100, 100);
}

/**
 * Gets the text color class based on usage percentage.
 */
export function getUsageColorClass(percentage: number): string {
  if (percentage >= CONTEXT_CRITICAL_THRESHOLD * 100) {
    return 'text-red-500';
  }
  if (percentage >= CONTEXT_WARNING_THRESHOLD * 100) {
    return 'text-yellow-500';
  }
  return 'text-muted-foreground';
}

/**
 * Gets the progress bar color class based on usage percentage.
 */
export function getProgressColorClass(percentage: number): string {
  if (percentage >= CONTEXT_CRITICAL_THRESHOLD * 100) {
    return '[&>div]:bg-red-500';
  }
  if (percentage >= CONTEXT_WARNING_THRESHOLD * 100) {
    return '[&>div]:bg-yellow-500';
  }
  return '[&>div]:bg-green-500';
}
