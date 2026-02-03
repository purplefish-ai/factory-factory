import { Clock, Coins, Database, Globe, Layers, Zap } from 'lucide-react';

import { Progress } from '@/components/ui/progress';
import type { TokenStats } from '@/lib/claude-types';
import { CONTEXT_CRITICAL_THRESHOLD, CONTEXT_WARNING_THRESHOLD } from '@/lib/claude-types';
import { cn } from '@/lib/utils';

interface UsageStatsPopoverProps {
  tokenStats: TokenStats;
}

/**
 * Formats a number with K/M suffix for display.
 */
function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return count.toLocaleString();
}

/**
 * Formats cost in USD with appropriate precision.
 */
function formatCost(cost: number): string {
  if (cost === 0) {
    return '$0.00';
  }
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  return `$${cost.toFixed(2)}`;
}

/**
 * Formats duration in milliseconds to a readable string.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Calculates cache hit rate as a percentage.
 */
function calculateCacheHitRate(stats: TokenStats): number {
  const totalCacheTokens = stats.cacheReadInputTokens + stats.cacheCreationInputTokens;
  if (totalCacheTokens === 0) {
    return 0;
  }
  return (stats.cacheReadInputTokens / totalCacheTokens) * 100;
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

interface StatRowProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  subValue?: string;
  className?: string;
}

function StatRow({ icon, label, value, subValue, className }: StatRowProps) {
  return (
    <div className={cn('flex items-center justify-between py-1', className)}>
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <div className="text-right">
        <span className="text-xs font-medium">{value}</span>
        {subValue && <span className="ml-1 text-xs text-muted-foreground">{subValue}</span>}
      </div>
    </div>
  );
}

/**
 * Detailed usage statistics popover content.
 * Shows token breakdown, cost, cache stats, and timing.
 */
export function UsageStatsPopover({ tokenStats }: UsageStatsPopoverProps) {
  const usedTokens = tokenStats.inputTokens + tokenStats.outputTokens;
  const usagePercentage = tokenStats.contextWindow
    ? Math.min((usedTokens / tokenStats.contextWindow) * 100, 100)
    : 0;
  const cacheHitRate = calculateCacheHitRate(tokenStats);
  const hasCacheData =
    tokenStats.cacheReadInputTokens > 0 || tokenStats.cacheCreationInputTokens > 0;

  return (
    <div className="p-3">
      <h4 className="mb-3 text-sm font-medium">Session Usage</h4>

      {/* Context Window Progress */}
      {tokenStats.contextWindow && (
        <div className="mb-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Context Window</span>
            <span className={cn('text-xs font-medium', getUsageColorClass(usagePercentage))}>
              {usagePercentage.toFixed(0)}%
            </span>
          </div>
          <Progress
            value={usagePercentage}
            className={cn('h-1.5', getProgressColorClass(usagePercentage))}
          />
          <div className="mt-1 flex justify-between text-xs text-muted-foreground">
            <span>{formatTokenCount(usedTokens)} used</span>
            <span>{formatTokenCount(tokenStats.contextWindow)} max</span>
          </div>
        </div>
      )}

      <div className="space-y-0.5">
        {/* Token Breakdown */}
        <StatRow
          icon={<Layers className="h-3 w-3" />}
          label="Input tokens"
          value={formatTokenCount(tokenStats.inputTokens)}
        />
        <StatRow
          icon={<Layers className="h-3 w-3" />}
          label="Output tokens"
          value={formatTokenCount(tokenStats.outputTokens)}
        />

        {/* Cache Stats */}
        {hasCacheData && (
          <>
            <div className="my-1.5 border-t" />
            <StatRow
              icon={<Database className="h-3 w-3" />}
              label="Cache read"
              value={formatTokenCount(tokenStats.cacheReadInputTokens)}
              subValue={cacheHitRate > 0 ? `(${cacheHitRate.toFixed(0)}% hit)` : undefined}
            />
            <StatRow
              icon={<Database className="h-3 w-3" />}
              label="Cache created"
              value={formatTokenCount(tokenStats.cacheCreationInputTokens)}
            />
          </>
        )}

        {/* Cost and Performance */}
        <div className="my-1.5 border-t" />
        <StatRow
          icon={<Coins className="h-3 w-3" />}
          label="Cost"
          value={formatCost(tokenStats.totalCostUsd)}
        />

        {tokenStats.turnCount > 0 && (
          <StatRow icon={<Zap className="h-3 w-3" />} label="Turns" value={tokenStats.turnCount} />
        )}

        {tokenStats.totalDurationMs > 0 && (
          <StatRow
            icon={<Clock className="h-3 w-3" />}
            label="Total time"
            value={formatDuration(tokenStats.totalDurationMs)}
          />
        )}

        {tokenStats.totalDurationApiMs > 0 && (
          <StatRow
            icon={<Clock className="h-3 w-3" />}
            label="API time"
            value={formatDuration(tokenStats.totalDurationApiMs)}
          />
        )}

        {tokenStats.webSearchRequests > 0 && (
          <StatRow
            icon={<Globe className="h-3 w-3" />}
            label="Web searches"
            value={tokenStats.webSearchRequests}
          />
        )}

        {/* Service Tier */}
        {tokenStats.serviceTier && (
          <>
            <div className="my-1.5 border-t" />
            <StatRow
              icon={<Zap className="h-3 w-3" />}
              label="Service tier"
              value={tokenStats.serviceTier}
            />
          </>
        )}
      </div>
    </div>
  );
}
