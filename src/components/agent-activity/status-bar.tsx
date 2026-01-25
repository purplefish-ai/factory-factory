'use client';

/**
 * Status bar component for agent activity
 * Shows connection state, agent status, and running state
 */

import {
  Activity,
  AlertCircle,
  GitBranch,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AgentMetadata, ConnectionState } from './types';

interface StatusBarProps {
  connectionState: ConnectionState;
  running: boolean;
  agentMetadata: AgentMetadata | null;
  onReconnect: () => void;
}

function ConnectionIndicator({ state }: { state: ConnectionState }) {
  switch (state) {
    case 'connected':
      return (
        <div className="flex items-center gap-1.5 text-green-600 dark:text-green-400">
          <Wifi className="h-4 w-4" />
          <span className="text-xs font-medium">Connected</span>
        </div>
      );
    case 'connecting':
      return (
        <div className="flex items-center gap-1.5 text-yellow-600 dark:text-yellow-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-xs font-medium">Connecting...</span>
        </div>
      );
    case 'disconnected':
      return (
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <WifiOff className="h-4 w-4" />
          <span className="text-xs font-medium">Disconnected</span>
        </div>
      );
    case 'error':
      return (
        <div className="flex items-center gap-1.5 text-red-600 dark:text-red-400">
          <AlertCircle className="h-4 w-4" />
          <span className="text-xs font-medium">Connection Error</span>
        </div>
      );
  }
}

function AgentStateIndicator({ metadata }: { metadata: AgentMetadata | null }) {
  if (!metadata) {
    return null;
  }

  const stateColors: Record<string, string> = {
    IDLE: 'text-muted-foreground',
    ACTIVE: 'text-green-600 dark:text-green-400',
    PAUSED: 'text-yellow-600 dark:text-yellow-400',
    CRASHED: 'text-red-600 dark:text-red-400',
  };

  const stateIcons: Record<string, React.ReactNode> = {
    IDLE: <Pause className="h-4 w-4" />,
    ACTIVE: <Play className="h-4 w-4" />,
    PAUSED: <Pause className="h-4 w-4" />,
    CRASHED: <AlertCircle className="h-4 w-4" />,
  };

  return (
    <div
      className={`flex items-center gap-1.5 ${stateColors[metadata.executionState] || 'text-muted-foreground'}`}
    >
      {stateIcons[metadata.executionState]}
      <span className="text-xs font-medium">{metadata.executionState}</span>
    </div>
  );
}

function ProcessIndicator({ running }: { running: boolean }) {
  if (running) {
    return (
      <div className="flex items-center gap-1.5 text-blue-600 dark:text-blue-400">
        <Activity className="h-4 w-4 animate-pulse" />
        <span className="text-xs font-medium">Processing</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 text-muted-foreground">
      <Activity className="h-4 w-4" />
      <span className="text-xs font-medium">Idle</span>
    </div>
  );
}

export function StatusBar({
  connectionState,
  running,
  agentMetadata,
  onReconnect,
}: StatusBarProps) {
  const showReconnect = connectionState === 'disconnected' || connectionState === 'error';

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-muted/50 border-b">
      <div className="flex items-center gap-4">
        <ConnectionIndicator state={connectionState} />
        <div className="h-4 w-px bg-border" />
        <AgentStateIndicator metadata={agentMetadata} />
        <div className="h-4 w-px bg-border" />
        <ProcessIndicator running={running} />

        {agentMetadata?.currentTask?.branchName && (
          <>
            <div className="h-4 w-px bg-border" />
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <GitBranch className="h-4 w-4" />
              <span className="text-xs font-mono">{agentMetadata.currentTask.branchName}</span>
            </div>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        {agentMetadata && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span
              className={`w-2 h-2 rounded-full ${
                agentMetadata.isHealthy ? 'bg-green-500' : 'bg-red-500'
              }`}
              title={agentMetadata.isHealthy ? 'Healthy' : 'Unhealthy'}
            />
            <span className="font-mono">{agentMetadata.type}</span>
          </div>
        )}

        {showReconnect && (
          <Button variant="ghost" size="sm" onClick={onReconnect} className="h-7 text-xs">
            <RefreshCw className="h-3 w-3 mr-1" />
            Reconnect
          </Button>
        )}
      </div>
    </div>
  );
}
