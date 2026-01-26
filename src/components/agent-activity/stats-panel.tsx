'use client';

import { Clock, Coins, Hash, MessageSquare } from 'lucide-react';
import type * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import type { TokenStats } from '@/lib/claude-types';
import { cn } from '@/lib/utils';

// =============================================================================
// Stats Panel
// =============================================================================

interface StatsPanelProps {
  stats: TokenStats;
  className?: string;
  variant?: 'card' | 'inline' | 'compact';
}

/**
 * Displays accumulated token usage, cost, and duration statistics.
 */
export function StatsPanel({ stats, className, variant = 'card' }: StatsPanelProps) {
  if (variant === 'inline') {
    return <StatsInline stats={stats} className={className} />;
  }

  if (variant === 'compact') {
    return <StatsCompact stats={stats} className={className} />;
  }

  return <StatsCard stats={stats} className={className} />;
}

// =============================================================================
// Stats Card Variant
// =============================================================================

interface StatsCardProps {
  stats: TokenStats;
  className?: string;
}

function StatsCard({ stats, className }: StatsCardProps) {
  return (
    <Card className={cn('', className)}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Session Statistics</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          <StatItem
            icon={<Hash className="h-4 w-4" />}
            label="Tokens"
            value={formatTokens(stats.inputTokens, stats.outputTokens)}
            detail={`${formatNumber(stats.inputTokens)} in / ${formatNumber(stats.outputTokens)} out`}
          />
          <StatItem
            icon={<Coins className="h-4 w-4" />}
            label="Cost"
            value={formatCost(stats.totalCostUsd)}
          />
          <StatItem
            icon={<Clock className="h-4 w-4" />}
            label="Duration"
            value={formatDuration(stats.totalDurationMs)}
          />
          <StatItem
            icon={<MessageSquare className="h-4 w-4" />}
            label="Turns"
            value={stats.turnCount.toString()}
          />
        </div>
      </CardContent>
    </Card>
  );
}

// =============================================================================
// Stats Inline Variant
// =============================================================================

interface StatsInlineProps {
  stats: TokenStats;
  className?: string;
}

function StatsInline({ stats, className }: StatsInlineProps) {
  return (
    <div className={cn('flex items-center gap-4 text-sm', className)}>
      <div className="flex items-center gap-1">
        <Hash className="h-3 w-3 text-muted-foreground" />
        <span className="text-muted-foreground">
          {formatNumber(stats.inputTokens + stats.outputTokens)} tokens
        </span>
      </div>
      <Separator orientation="vertical" className="h-4" />
      <div className="flex items-center gap-1">
        <Coins className="h-3 w-3 text-muted-foreground" />
        <span className="text-muted-foreground">{formatCost(stats.totalCostUsd)}</span>
      </div>
      <Separator orientation="vertical" className="h-4" />
      <div className="flex items-center gap-1">
        <Clock className="h-3 w-3 text-muted-foreground" />
        <span className="text-muted-foreground">{formatDuration(stats.totalDurationMs)}</span>
      </div>
      <Separator orientation="vertical" className="h-4" />
      <div className="flex items-center gap-1">
        <MessageSquare className="h-3 w-3 text-muted-foreground" />
        <span className="text-muted-foreground">{stats.turnCount} turns</span>
      </div>
    </div>
  );
}

// =============================================================================
// Stats Compact Variant
// =============================================================================

interface StatsCompactProps {
  stats: TokenStats;
  className?: string;
}

function StatsCompact({ stats, className }: StatsCompactProps) {
  const totalTokens = stats.inputTokens + stats.outputTokens;

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-md bg-muted/50 px-3 py-1.5 text-xs',
        className
      )}
    >
      <span className="font-mono">{formatNumber(totalTokens)} tok</span>
      <span className="text-muted-foreground">|</span>
      <span className="font-mono">{formatCost(stats.totalCostUsd)}</span>
      <span className="text-muted-foreground">|</span>
      <span className="font-mono">{formatDurationShort(stats.totalDurationMs)}</span>
    </div>
  );
}

// =============================================================================
// Stat Item Component
// =============================================================================

interface StatItemProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
}

function StatItem({ icon, label, value, detail }: StatItemProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <div className="font-medium">{value}</div>
      {detail && <div className="text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}

// =============================================================================
// Formatting Utilities
// =============================================================================

/**
 * Formats a number with thousands separators.
 */
function formatNumber(num: number): string {
  return num.toLocaleString();
}

/**
 * Formats token counts as a combined string.
 */
function formatTokens(input: number, output: number): string {
  const total = input + output;
  if (total >= 1_000_000) {
    return `${(total / 1_000_000).toFixed(1)}M`;
  }
  if (total >= 1000) {
    return `${(total / 1000).toFixed(1)}K`;
  }
  return total.toString();
}

/**
 * Formats cost in USD.
 */
function formatCost(cost: number): string {
  if (cost === 0) {
    return '$0.00';
  }
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  if (cost < 1) {
    return `$${cost.toFixed(3)}`;
  }
  return `$${cost.toFixed(2)}`;
}

/**
 * Formats duration in a human-readable format.
 */
function formatDuration(ms: number): string {
  if (ms === 0) {
    return '0s';
  }

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }

  if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  return `${seconds}s`;
}

/**
 * Formats duration in a short format.
 */
function formatDurationShort(ms: number): string {
  if (ms === 0) {
    return '0s';
  }

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h${minutes % 60}m`;
  }

  if (minutes > 0) {
    return `${minutes}m${seconds % 60}s`;
  }

  return `${seconds}s`;
}

// =============================================================================
// Exports
// =============================================================================

export { formatNumber, formatTokens, formatCost, formatDuration, formatDurationShort };
