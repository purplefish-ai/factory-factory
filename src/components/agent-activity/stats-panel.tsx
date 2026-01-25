'use client';

/**
 * Stats panel component for agent activity
 * Displays token usage, cost, and duration statistics
 */

import { Clock, Coins, Hash, Layers } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { TokenStats } from './types';

interface StatsPanelProps {
  stats: TokenStats;
  className?: string;
}

function formatCost(usd: number): string {
  if (usd === 0) {
    return '$0.00';
  }
  if (usd < 0.01) {
    return `${(usd * 100).toFixed(3)}c`;
  }
  if (usd < 1) {
    return `${(usd * 100).toFixed(2)}c`;
  }
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms === 0) {
    return '0s';
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatTokens(count: number): string {
  if (count === 0) {
    return '0';
  }
  if (count < 1000) {
    return count.toString();
  }
  if (count < 1_000_000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return `${(count / 1_000_000).toFixed(2)}M`;
}

interface StatItemProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  subValue?: string;
}

function StatItem({ icon, label, value, subValue }: StatItemProps) {
  return (
    <div className="flex items-center gap-3">
      <div className="p-2 bg-muted rounded-lg">{icon}</div>
      <div>
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-sm font-semibold">{value}</div>
        {subValue && <div className="text-xs text-muted-foreground">{subValue}</div>}
      </div>
    </div>
  );
}

export function StatsPanel({ stats, className }: StatsPanelProps) {
  const totalTokens = stats.inputTokens + stats.outputTokens;

  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Session Stats</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4">
        <StatItem
          icon={<Hash className="h-4 w-4 text-muted-foreground" />}
          label="Tokens"
          value={formatTokens(totalTokens)}
          subValue={`${formatTokens(stats.inputTokens)} in / ${formatTokens(stats.outputTokens)} out`}
        />
        <StatItem
          icon={<Coins className="h-4 w-4 text-muted-foreground" />}
          label="Cost"
          value={formatCost(stats.totalCostUsd)}
        />
        <StatItem
          icon={<Clock className="h-4 w-4 text-muted-foreground" />}
          label="Duration"
          value={formatDuration(stats.totalDurationMs)}
        />
        <StatItem
          icon={<Layers className="h-4 w-4 text-muted-foreground" />}
          label="Turns"
          value={stats.turnCount.toString()}
        />
      </CardContent>
    </Card>
  );
}

interface CompactStatsProps {
  stats: TokenStats;
  className?: string;
}

/** Compact inline stats display */
export function CompactStats({ stats, className }: CompactStatsProps) {
  const totalTokens = stats.inputTokens + stats.outputTokens;

  return (
    <div className={`flex items-center gap-4 text-xs text-muted-foreground ${className || ''}`}>
      <div className="flex items-center gap-1">
        <Hash className="h-3 w-3" />
        <span>{formatTokens(totalTokens)}</span>
      </div>
      <div className="flex items-center gap-1">
        <Coins className="h-3 w-3" />
        <span>{formatCost(stats.totalCostUsd)}</span>
      </div>
      <div className="flex items-center gap-1">
        <Clock className="h-3 w-3" />
        <span>{formatDuration(stats.totalDurationMs)}</span>
      </div>
      <div className="flex items-center gap-1">
        <Layers className="h-3 w-3" />
        <span>{stats.turnCount} turns</span>
      </div>
    </div>
  );
}
