'use client';

import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import type { ChatMessage } from '@/lib/claude-types';
import { extractTextFromMessage } from '@/lib/claude-types';
import { cn } from '@/lib/utils';
import { AssistantMessageRenderer, LoadingIndicator, MessageWrapper } from './message-renderers';
import { StatsPanel } from './stats-panel';
import { MinimalStatus, StatusBar } from './status-bar';
import { useAgentWebSocket } from './use-agent-websocket';

// =============================================================================
// Agent Activity Component
// =============================================================================

export interface AgentActivityProps {
  /** The agent ID to connect to */
  agentId: string;
  /** Optional project slug for file path context */
  projectSlug?: string;
  /** Whether to show the stats panel */
  showStats?: boolean;
  /** Whether to show the status bar */
  showStatusBar?: boolean;
  /** Additional CSS classes */
  className?: string;
  /** Height of the scroll area (default: 'h-[500px]') */
  height?: string;
  /** Whether to auto-connect on mount */
  autoConnect?: boolean;
}

/**
 * Main component for viewing agent Claude sessions.
 * This is a read-only view - agents are controlled by the backend.
 */
export function AgentActivity({
  agentId,
  projectSlug: _projectSlug,
  showStats = true,
  showStatusBar = true,
  className,
  height = 'h-[500px]',
  autoConnect = true,
}: AgentActivityProps) {
  const {
    messages,
    connected: _connected,
    connectionState,
    running,
    agentMetadata,
    tokenStats,
    claudeSessionId: _claudeSessionId,
    error,
    reconnect,
    messagesEndRef,
  } = useAgentWebSocket({ agentId, autoConnect });

  return (
    <div className={cn('flex flex-col', className)}>
      {/* Status Bar */}
      {showStatusBar && (
        <StatusBar
          connectionState={connectionState}
          running={running}
          agentMetadata={agentMetadata}
          error={error}
          onReconnect={reconnect}
          className="mb-3"
        />
      )}

      {/* Main Content Area */}
      <div className="flex gap-4">
        {/* Message List */}
        <div className="flex-1 min-w-0">
          <ScrollArea className={cn('rounded-md border', height)}>
            <div className="p-4 space-y-4">
              {/* Empty State */}
              {messages.length === 0 && !running && (
                <EmptyState connectionState={connectionState} />
              )}

              {/* Messages */}
              {messages.map((message) => (
                <MessageItem key={message.id} message={message} />
              ))}

              {/* Loading Indicator */}
              {running && <LoadingIndicator className="py-4" />}

              {/* Scroll Anchor */}
              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>
        </div>

        {/* Stats Panel (side) */}
        {showStats && (
          <div className="w-64 shrink-0">
            <StatsPanel stats={tokenStats} />
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Compact Agent Activity
// =============================================================================

export interface CompactAgentActivityProps {
  agentId: string;
  className?: string;
  maxMessages?: number;
}

/**
 * A compact version of the agent activity viewer.
 * Shows fewer messages and uses inline stats.
 */
export function CompactAgentActivity({
  agentId,
  className,
  maxMessages = 10,
}: CompactAgentActivityProps) {
  const {
    messages,
    connectionState,
    running,
    tokenStats,
    reconnect: _reconnect,
    messagesEndRef,
  } = useAgentWebSocket({ agentId });

  // Only show the last N messages
  const displayMessages = messages.slice(-maxMessages);

  return (
    <div className={cn('rounded-md border', className)}>
      {/* Header with status */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <MinimalStatus connectionState={connectionState} running={running} />
          <span className="text-sm font-medium">Agent Activity</span>
        </div>
        <StatsPanel stats={tokenStats} variant="compact" />
      </div>

      {/* Message List */}
      <ScrollArea className="h-48">
        <div className="p-3 space-y-2">
          {displayMessages.map((message) => (
            <CompactMessageItem key={message.id} message={message} />
          ))}

          {running && <LoadingIndicator className="py-2" />}

          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>
    </div>
  );
}

// =============================================================================
// Message Item
// =============================================================================

interface MessageItemProps {
  message: ChatMessage;
}

function MessageItem({ message }: MessageItemProps) {
  // User messages
  if (message.source === 'user') {
    return (
      <MessageWrapper chatMessage={message}>
        <div className="rounded-lg bg-primary text-primary-foreground px-3 py-2 inline-block">
          {message.text}
        </div>
      </MessageWrapper>
    );
  }

  // Claude messages
  if (message.message) {
    return (
      <MessageWrapper chatMessage={message}>
        <AssistantMessageRenderer message={message.message} />
      </MessageWrapper>
    );
  }

  return null;
}

// =============================================================================
// Compact Message Item
// =============================================================================

interface CompactMessageItemProps {
  message: ChatMessage;
}

function CompactMessageItem({ message }: CompactMessageItemProps) {
  if (message.source === 'user') {
    return (
      <div className="text-sm text-muted-foreground">
        <span className="font-medium">User:</span> {message.text}
      </div>
    );
  }

  if (message.message) {
    const text = extractTextFromMessage(message.message);
    if (!text) {
      return null;
    }

    // Truncate long messages
    const displayText = text.length > 100 ? `${text.slice(0, 100)}...` : text;

    return (
      <div className="text-sm">
        <span className="font-medium text-muted-foreground">Agent:</span> <span>{displayText}</span>
      </div>
    );
  }

  return null;
}

// =============================================================================
// Empty State
// =============================================================================

interface EmptyStateProps {
  connectionState: string;
}

function EmptyState({ connectionState }: EmptyStateProps) {
  if (connectionState === 'connecting') {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Skeleton className="h-12 w-12 rounded-full mb-4" />
        <Skeleton className="h-4 w-32 mb-2" />
        <Skeleton className="h-3 w-48" />
      </div>
    );
  }

  if (connectionState === 'error' || connectionState === 'disconnected') {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
        <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
          <span className="text-2xl">!</span>
        </div>
        <p className="font-medium">Connection Lost</p>
        <p className="text-sm">Unable to connect to agent activity stream</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
      <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
        <span className="text-2xl">-</span>
      </div>
      <p className="font-medium">No Activity Yet</p>
      <p className="text-sm">Agent output will appear here when activity starts</p>
    </div>
  );
}
