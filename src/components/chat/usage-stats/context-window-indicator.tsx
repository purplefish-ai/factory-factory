import { Activity } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import type { TokenStats } from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';
import { UsageStatsPopover } from './usage-stats-popover';
import {
  calculateContextUsagePercentage,
  getProgressColorClass,
  getUsageColorClass,
} from './usage-stats-utils';

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
 * Compact context window usage indicator for the chat input toolbar.
 * Shows current usage as a percentage with color coding.
 * Click to open detailed usage stats popover.
 */
export function ContextWindowIndicator({ tokenStats, className }: ContextWindowIndicatorProps) {
  const usagePercentage = calculateContextUsagePercentage(tokenStats);
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
