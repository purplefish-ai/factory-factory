'use client';

import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import type { ChatMessage, GroupedMessageItem } from '@/lib/claude-types';
import {
  extractTextFromMessage,
  groupAdjacentToolCalls,
  isThinkingContent,
  isToolSequence,
} from '@/lib/claude-types';
import { cn } from '@/lib/utils';
import {
  AssistantMessageRenderer,
  LoadingIndicator,
  MessageWrapper,
  ThinkingCompletionProvider,
} from './message-renderers';
import { StatsPanel } from './stats-panel';
import { MinimalStatus, StatusBar } from './status-bar';
import { ToolSequenceGroup } from './tool-renderers';
import type { AgentMetadata, ConnectionState, TokenStats } from './types';
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

  // Find the last message with thinking content for completion tracking
  const lastThinkingMessageId = findLastThinkingMessageId(messages);

  return (
    <ThinkingCompletionProvider lastThinkingMessageId={lastThinkingMessageId} running={running}>
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
              <div className="p-4 space-y-2">
                {/* Empty State */}
                {messages.length === 0 && !running && (
                  <EmptyState connectionState={connectionState} />
                )}

                {/* Messages (with tool call grouping) */}
                {groupAdjacentToolCalls(messages).map((item) => (
                  <GroupedMessageItemRenderer
                    key={isToolSequence(item) ? item.id : item.id}
                    item={item}
                  />
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
    </ThinkingCompletionProvider>
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

export interface MessageItemProps {
  message: ChatMessage;
}

export function MessageItem({ message }: MessageItemProps) {
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
        <AssistantMessageRenderer message={message.message} messageId={message.id} />
      </MessageWrapper>
    );
  }

  return null;
}

// =============================================================================
// Grouped Message Item Renderer
// =============================================================================

export interface GroupedMessageItemRendererProps {
  item: GroupedMessageItem;
}

/**
 * Renders either a regular message or a tool sequence group.
 */
export function GroupedMessageItemRenderer({ item }: GroupedMessageItemRendererProps) {
  if (isToolSequence(item)) {
    return <ToolSequenceGroup sequence={item} />;
  }
  return <MessageItem message={item} />;
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

// =============================================================================
// Helper: Find last thinking message
// =============================================================================

/**
 * Finds the ID of the last message that contains thinking content.
 * This is used to determine which thinking block is potentially "in progress".
 */
function findLastThinkingMessageId(messages: ChatMessage[]): string | null {
  // Iterate backwards to find the last thinking message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.source === 'claude' && msg.message) {
      const claudeMsg = msg.message;
      // Check if this is a stream event with thinking content
      if (claudeMsg.type === 'stream_event' && claudeMsg.event) {
        if (
          claudeMsg.event.type === 'content_block_start' &&
          isThinkingContent(claudeMsg.event.content_block)
        ) {
          return msg.id;
        }
      }
    }
  }
  return null;
}

// =============================================================================
// Mock Agent Activity (for Storybook/testing)
// =============================================================================

export interface MockAgentActivityProps {
  /** Pre-loaded messages to display */
  messages: ChatMessage[];
  /** Connection state to simulate */
  connectionState?: ConnectionState;
  /** Whether the agent appears to be running */
  running?: boolean;
  /** Agent metadata to display */
  agentMetadata?: AgentMetadata | null;
  /** Token stats to display */
  tokenStats?: TokenStats | null;
  /** Error message to display */
  error?: string | null;
  /** Whether to show the stats panel */
  showStats?: boolean;
  /** Whether to show the status bar */
  showStatusBar?: boolean;
  /** Additional CSS classes */
  className?: string;
  /** Height of the scroll area */
  height?: string;
}

/**
 * Mock version of AgentActivity for Storybook testing.
 * Accepts messages and state as props instead of using WebSocket.
 */
export function MockAgentActivity({
  messages,
  connectionState = 'connected',
  running = false,
  agentMetadata = null,
  tokenStats = null,
  error = null,
  showStats = true,
  showStatusBar = true,
  className,
  height = 'h-[500px]',
}: MockAgentActivityProps) {
  // Find the last message with thinking content for completion tracking
  const lastThinkingMessageId = findLastThinkingMessageId(messages);

  return (
    <ThinkingCompletionProvider lastThinkingMessageId={lastThinkingMessageId} running={running}>
      <div className={cn('flex flex-col', className)}>
        {/* Status Bar */}
        {showStatusBar && (
          <StatusBar
            connectionState={connectionState}
            running={running}
            agentMetadata={agentMetadata}
            error={error}
            onReconnect={() => {
              // No-op for mock component
            }}
            className="mb-3"
          />
        )}

        {/* Main Content Area */}
        <div className="flex gap-4">
          {/* Message List */}
          <div className="flex-1 min-w-0">
            <ScrollArea className={cn('rounded-md border', height)}>
              <div className="p-4 space-y-2">
                {/* Empty State */}
                {messages.length === 0 && !running && (
                  <EmptyState connectionState={connectionState} />
                )}

                {/* Messages (with tool call grouping) */}
                {groupAdjacentToolCalls(messages).map((item) => (
                  <GroupedMessageItemRenderer
                    key={isToolSequence(item) ? item.id : item.id}
                    item={item}
                  />
                ))}

                {/* Loading Indicator */}
                {running && <LoadingIndicator className="py-4" />}
              </div>
            </ScrollArea>
          </div>

          {/* Stats Panel (side) */}
          {showStats && tokenStats && (
            <div className="w-64 shrink-0">
              <StatsPanel stats={tokenStats} />
            </div>
          )}
        </div>
      </div>
    </ThinkingCompletionProvider>
  );
}

export interface MockCompactAgentActivityProps {
  /** Pre-loaded messages to display */
  messages: ChatMessage[];
  /** Connection state to simulate */
  connectionState?: ConnectionState;
  /** Whether the agent appears to be running */
  running?: boolean;
  /** Token stats to display */
  tokenStats?: TokenStats | null;
  /** Maximum messages to show */
  maxMessages?: number;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Mock version of CompactAgentActivity for Storybook testing.
 */
export function MockCompactAgentActivity({
  messages,
  connectionState = 'connected',
  running = false,
  tokenStats = null,
  maxMessages = 10,
  className,
}: MockCompactAgentActivityProps) {
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
        {tokenStats && <StatsPanel stats={tokenStats} variant="compact" />}
      </div>

      {/* Message List */}
      <ScrollArea className="h-48">
        <div className="p-3 space-y-2">
          {displayMessages.map((message) => (
            <CompactMessageItem key={message.id} message={message} />
          ))}

          {running && <LoadingIndicator className="py-2" />}
        </div>
      </ScrollArea>
    </div>
  );
}
