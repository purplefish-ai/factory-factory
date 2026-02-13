import { Activity } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import type { TokenStats } from '@/lib/chat-protocol';
import { CONTEXT_CRITICAL_THRESHOLD, CONTEXT_WARNING_THRESHOLD } from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';
import { UsageStatsPopover } from './usage-stats-popover';

interface ContextWindowIndicatorProps {
  tokenStats: TokenStats;
  className?: string;
}

/**
 * Formats a number with K/M suffix for compact display.
 */
function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(0)}K`;
  }
  return count.toString();
}

/**
 * Calculates context window usage percentage.
 * Returns 0 if context window is not available.
 */
function calculateUsagePercentage(stats: TokenStats): number {
  if (!stats.contextWindow || stats.contextWindow === 0) {
    return 0;
  }
  const usedTokens = stats.inputTokens + stats.outputTokens;
  return Math.min((usedTokens / stats.contextWindow) * 100, 100);
}

/**
 * Gets the color class based on usage percentage.
 */
function getUsageColorClass(percentage: number): string {
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
function getProgressColorClass(percentage: number): string {
  if (percentage >= CONTEXT_CRITICAL_THRESHOLD * 100) {
    return '[&>div]:bg-red-500';
  }
  if (percentage >= CONTEXT_WARNING_THRESHOLD * 100) {
    return '[&>div]:bg-yellow-500';
  }
  return '[&>div]:bg-green-500';
}

/**
 * Compact context window usage indicator for the chat input toolbar.
 * Shows current usage as a percentage with color coding.
 * Click to open detailed usage stats popover.
 */
export function ContextWindowIndicator({ tokenStats, className }: ContextWindowIndicatorProps) {
  const usagePercentage = calculateUsagePercentage(tokenStats);
  const usedTokens = tokenStats.inputTokens + tokenStats.outputTokens;
  const hasData = usedTokens > 0;

  // Don't show if no data yet
  if (!hasData) {
    return null;
  }

  const colorClass = getUsageColorClass(usagePercentage);
  const progressColorClass = getProgressColorClass(usagePercentage);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn('h-6 gap-1.5 px-2 text-xs', colorClass, className)}
          aria-label="View usage statistics"
        >
          <Activity className="h-3 w-3" />
          <div className="flex items-center gap-1.5">
            <span>{formatTokenCount(usedTokens)}</span>
            {tokenStats.contextWindow && (
              <>
                <span className="text-muted-foreground">/</span>
                <span className="text-muted-foreground">
                  {formatTokenCount(tokenStats.contextWindow)}
                </span>
              </>
            )}
          </div>
          {tokenStats.contextWindow && (
            <Progress value={usagePercentage} className={cn('h-1 w-8', progressColorClass)} />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <UsageStatsPopover tokenStats={tokenStats} />
      </PopoverContent>
    </Popover>
  );
}
