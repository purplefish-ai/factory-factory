'use client';

/**
 * Main agent activity container component
 * Displays Claude messages, tool calls, and agent metadata
 */

import { groupMessages } from '../chat/message-utils';
import type { ChatMessage, ClaudeMessage } from '../chat/types';
import { MessageRenderer } from './message-renderers';
import { CompactStats, StatsPanel } from './stats-panel';
import { StatusBar } from './status-bar';
import { ToolCallGroupRenderer } from './tool-renderers';
import type { AgentMetadata } from './types';
import { useAgentWebSocket } from './use-agent-websocket';

interface AgentActivityProps {
  /** Agent ID to connect to */
  agentId: string;
  /** Optional project slug for file links */
  projectSlug?: string;
  /** Whether to show the stats panel */
  showStats?: boolean;
  /** Whether to show the status bar */
  showStatusBar?: boolean;
  /** Optional custom class name */
  className?: string;
}

interface AssistantGroupRendererProps {
  messages: ChatMessage[];
}

/** Render a group of assistant messages */
function AssistantGroupRenderer({ messages }: AssistantGroupRendererProps) {
  const renderedMessages = messages
    .map((m) => m.message)
    .filter((m): m is ClaudeMessage => m !== undefined);

  // Check if there's any visible content
  const hasContent = renderedMessages.some((msg) => {
    if (msg.type === 'assistant') {
      const content = (msg.message as { content?: Array<{ type?: string; text?: string }> })
        ?.content;
      return content?.some((c) => (c.type === 'text' || !c.type) && c.text);
    }
    if (msg.type === 'content_block_delta') {
      return (msg.delta as { text?: string })?.text;
    }
    if (msg.type === 'result') {
      return true; // Result messages have stats to display
    }
    if (msg.type === 'system') {
      return typeof msg.message === 'string' && msg.message.length > 0;
    }
    if (msg.type === 'error') {
      return !!(msg.error as string);
    }
    return false;
  });

  if (!hasContent) {
    return null;
  }

  return (
    <div className="p-4 bg-muted/50 rounded-lg space-y-2">
      <div className="text-xs text-muted-foreground font-medium">Claude</div>
      {renderedMessages.map((msg) => (
        <MessageRenderer key={`${msg.type}-${msg.timestamp}`} message={msg} />
      ))}
    </div>
  );
}

interface MessageListProps {
  messages: ChatMessage[];
  projectSlug?: string;
}

/** Render grouped messages */
function MessageList({ messages, projectSlug }: MessageListProps) {
  const groups = groupMessages(messages);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <p className="text-sm">No messages yet</p>
          <p className="text-xs mt-1">Waiting for agent activity...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => {
        if (group.type === 'user') {
          // User messages shouldn't appear in agent activity, but handle gracefully
          return (
            <div key={group.id} className="p-4 bg-primary/10 rounded-lg ml-8">
              <div className="text-xs text-muted-foreground mb-2 font-medium">User</div>
              <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap">
                {group.messages[0].text || ''}
              </div>
            </div>
          );
        }
        if (group.type === 'tool_group') {
          const toolMessages = group.messages
            .map((m) => m.message)
            .filter((m): m is ClaudeMessage => m !== undefined);
          return (
            <ToolCallGroupRenderer
              key={group.id}
              messages={toolMessages}
              projectSlug={projectSlug}
            />
          );
        }
        return <AssistantGroupRenderer key={group.id} messages={group.messages} />;
      })}
    </div>
  );
}

interface AgentInfoProps {
  metadata: AgentMetadata;
}

/** Display agent metadata */
function AgentInfo({ metadata }: AgentInfoProps) {
  return (
    <div className="px-4 py-3 bg-muted/30 border-b space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">{metadata.type}</span>
          {metadata.currentTask && (
            <span className="text-sm text-muted-foreground">
              Working on: {metadata.currentTask.title}
            </span>
          )}
        </div>
        <span className="text-xs font-mono text-muted-foreground">
          {metadata.id.slice(0, 8)}...
        </span>
      </div>
      {metadata.worktreePath && (
        <div className="text-xs text-muted-foreground font-mono truncate">
          {metadata.worktreePath}
        </div>
      )}
    </div>
  );
}

/** Main agent activity component */
export function AgentActivity({
  agentId,
  projectSlug,
  showStats = true,
  showStatusBar = true,
  className = '',
}: AgentActivityProps) {
  const {
    messages,
    connectionState,
    running,
    agentMetadata,
    tokenStats,
    error,
    reconnect,
    messagesEndRef,
  } = useAgentWebSocket({ agentId });

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Status bar */}
      {showStatusBar && (
        <StatusBar
          connectionState={connectionState}
          running={running}
          agentMetadata={agentMetadata}
          onReconnect={reconnect}
        />
      )}

      {/* Agent info */}
      {agentMetadata && <AgentInfo metadata={agentMetadata} />}

      {/* Main content area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4">
          {error && (
            <div className="mb-4 p-4 bg-red-50 dark:bg-red-950/30 rounded-lg border border-red-200 dark:border-red-800">
              <div className="text-sm font-medium text-red-700 dark:text-red-300">Error</div>
              <div className="text-sm text-red-600 dark:text-red-400 mt-1">{error}</div>
            </div>
          )}

          <MessageList messages={messages} projectSlug={projectSlug} />

          {/* Scroll anchor */}
          <div ref={messagesEndRef} />
        </div>

        {/* Stats sidebar */}
        {showStats && (
          <div className="w-64 border-l p-4 hidden lg:block">
            <StatsPanel stats={tokenStats} />
          </div>
        )}
      </div>

      {/* Compact stats for mobile */}
      {showStats && (
        <div className="px-4 py-2 border-t bg-muted/30 lg:hidden">
          <CompactStats stats={tokenStats} />
        </div>
      )}
    </div>
  );
}

/** Export hook for custom implementations */
export { useAgentWebSocket };
export type { AgentActivityProps };
