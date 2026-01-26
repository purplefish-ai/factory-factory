'use client';

import {
  Activity,
  AlertCircle,
  CheckCircle,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import type { AgentMetadata, ConnectionState } from '@/lib/claude-types';
import { cn } from '@/lib/utils';

// =============================================================================
// Status Bar
// =============================================================================

interface StatusBarProps {
  connectionState: ConnectionState;
  running: boolean;
  agentMetadata: AgentMetadata | null;
  error: string | null;
  onReconnect?: () => void;
  className?: string;
}

/**
 * Displays connection status, agent metadata, and provides reconnect functionality.
 */
export function StatusBar({
  connectionState,
  running,
  agentMetadata,
  error,
  onReconnect,
  className,
}: StatusBarProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 rounded-md border bg-muted/30 px-3 py-2',
        className
      )}
    >
      <div className="flex items-center gap-4">
        {/* Connection Status */}
        <ConnectionIndicator state={connectionState} />

        <Separator orientation="vertical" className="h-5" />

        {/* Agent Status */}
        <AgentStatusIndicator running={running} agentMetadata={agentMetadata} />

        {/* Agent Type & Task Info */}
        {agentMetadata && (
          <>
            <Separator orientation="vertical" className="h-5" />
            <AgentMetadataDisplay metadata={agentMetadata} />
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        {/* Error Display */}
        {error && (
          <div className="flex items-center gap-1 text-destructive text-sm">
            <AlertCircle className="h-3 w-3" />
            <span className="max-w-48 truncate">{error}</span>
          </div>
        )}

        {/* Reconnect Button */}
        {(connectionState === 'disconnected' || connectionState === 'error') && onReconnect && (
          <Button variant="outline" size="sm" onClick={onReconnect}>
            <RefreshCw className="h-3 w-3 mr-1" />
            Reconnect
          </Button>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Connection Indicator
// =============================================================================

interface ConnectionIndicatorProps {
  state: ConnectionState;
}

function ConnectionIndicator({ state }: ConnectionIndicatorProps) {
  const config = getConnectionConfig(state);

  return (
    <div className="flex items-center gap-1.5">
      <config.icon className={cn('h-4 w-4', config.iconClass)} />
      <span className={cn('text-sm', config.textClass)}>{config.label}</span>
    </div>
  );
}

function getConnectionConfig(state: ConnectionState): {
  icon: React.ElementType;
  iconClass: string;
  textClass: string;
  label: string;
} {
  switch (state) {
    case 'connecting':
      return {
        icon: Loader2,
        iconClass: 'animate-spin text-muted-foreground',
        textClass: 'text-muted-foreground',
        label: 'Connecting...',
      };
    case 'connected':
      return {
        icon: Wifi,
        iconClass: 'text-success',
        textClass: 'text-success',
        label: 'Connected',
      };
    case 'disconnected':
      return {
        icon: WifiOff,
        iconClass: 'text-muted-foreground',
        textClass: 'text-muted-foreground',
        label: 'Disconnected',
      };
    case 'error':
      return {
        icon: AlertCircle,
        iconClass: 'text-destructive',
        textClass: 'text-destructive',
        label: 'Error',
      };
  }
}

// =============================================================================
// Agent Status Indicator
// =============================================================================

interface AgentStatusIndicatorProps {
  running: boolean;
  agentMetadata: AgentMetadata | null;
}

function AgentStatusIndicator({ running, agentMetadata }: AgentStatusIndicatorProps) {
  // Determine agent state
  const executionState = agentMetadata?.executionState ?? 'unknown';

  if (running) {
    return (
      <div className="flex items-center gap-1.5">
        <Activity className="h-4 w-4 text-success animate-pulse" />
        <span className="text-sm text-success">Running</span>
      </div>
    );
  }

  // Map execution states to display
  switch (executionState) {
    case 'running':
      return (
        <div className="flex items-center gap-1.5">
          <Activity className="h-4 w-4 text-success animate-pulse" />
          <span className="text-sm text-success">Running</span>
        </div>
      );
    case 'paused':
      return (
        <div className="flex items-center gap-1.5">
          <Pause className="h-4 w-4 text-warning" />
          <span className="text-sm text-warning">Paused</span>
        </div>
      );
    case 'stopped':
      return (
        <div className="flex items-center gap-1.5">
          <CheckCircle className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Stopped</span>
        </div>
      );
    case 'pending':
      return (
        <div className="flex items-center gap-1.5">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Pending</span>
        </div>
      );
    case 'error':
      return (
        <div className="flex items-center gap-1.5">
          <AlertCircle className="h-4 w-4 text-destructive" />
          <span className="text-sm text-destructive">Error</span>
        </div>
      );
    default:
      return (
        <div className="flex items-center gap-1.5">
          <Play className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Idle</span>
        </div>
      );
  }
}

// =============================================================================
// Agent Metadata Display
// =============================================================================

interface AgentMetadataDisplayProps {
  metadata: AgentMetadata;
}

function AgentMetadataDisplay({ metadata }: AgentMetadataDisplayProps) {
  return (
    <div className="flex items-center gap-2">
      {/* Agent Type */}
      <Badge variant="outline" className="text-xs capitalize">
        {formatAgentType(metadata.type)}
      </Badge>

      {/* Health Status */}
      {!metadata.isHealthy && (
        <Badge variant="destructive" className="text-xs">
          Unhealthy
        </Badge>
      )}

      {/* Current Task */}
      {metadata.currentTask && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground max-w-60">
          <span className="truncate">{metadata.currentTask.title}</span>
          <Badge variant="secondary" className="text-xs shrink-0">
            {metadata.currentTask.state}
          </Badge>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Minimal Status Indicator
// =============================================================================

interface MinimalStatusProps {
  connectionState: ConnectionState;
  running: boolean;
  className?: string;
}

/**
 * A minimal status indicator for compact layouts.
 */
export function MinimalStatus({ connectionState, running, className }: MinimalStatusProps) {
  const isConnected = connectionState === 'connected';

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {/* Connection Dot */}
      <div
        className={cn('h-2 w-2 rounded-full', isConnected ? 'bg-success' : 'bg-muted-foreground')}
      />

      {/* Running Animation */}
      {running && (
        <div className="flex gap-0.5">
          <div className="h-2 w-0.5 bg-success animate-pulse" style={{ animationDelay: '0ms' }} />
          <div className="h-2 w-0.5 bg-success animate-pulse" style={{ animationDelay: '150ms' }} />
          <div className="h-2 w-0.5 bg-success animate-pulse" style={{ animationDelay: '300ms' }} />
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Utility Functions
// =============================================================================

function formatAgentType(type: string): string {
  // Convert snake_case or camelCase to readable format
  return type
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
}
