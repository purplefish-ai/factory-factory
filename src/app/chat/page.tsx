'use client';

import { Plus } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef } from 'react';

import { GroupedMessageItemRenderer, LoadingIndicator } from '@/components/agent-activity';
import {
  ChatInput,
  PermissionPrompt,
  QuestionPrompt,
  SessionPicker,
  useChatWebSocket,
} from '@/components/chat';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { groupAdjacentToolCalls } from '@/lib/claude-types';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

type ConnectionStatus = 'connected' | 'processing' | 'disconnected' | 'loading';

// =============================================================================
// Helper Components
// =============================================================================

/**
 * Gets the human-readable status text for screen readers.
 */
function getStatusText(status: ConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'processing':
      return 'Processing request';
    case 'loading':
      return 'Loading session';
    case 'disconnected':
      return 'Disconnected';
  }
}

/**
 * Status indicator dot that shows connection state.
 * - Green: connected and idle
 * - Yellow: processing (running)
 * - Red: disconnected
 */
function StatusDot({ status }: { status: ConnectionStatus }) {
  const statusText = getStatusText(status);

  return (
    <>
      <div
        className={cn(
          'h-2.5 w-2.5 rounded-full',
          status === 'connected' && 'bg-green-500',
          status === 'processing' && 'bg-yellow-500 animate-pulse',
          status === 'loading' && 'bg-blue-500 animate-pulse',
          status === 'disconnected' && 'bg-red-500'
        )}
        title={statusText}
        aria-hidden="true"
      />
      {/* Screen reader announcement for status changes */}
      <output className="sr-only" aria-live="polite">
        {statusText}
      </output>
    </>
  );
}

/**
 * Loading fallback for Suspense boundary.
 */
function ChatLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="text-sm text-muted-foreground">Loading chat...</p>
      </div>
    </div>
  );
}

/**
 * Empty state when there are no messages.
 */
function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center p-8">
      <div className="text-muted-foreground space-y-2">
        <p className="text-lg font-medium">No messages yet</p>
        <p className="text-sm">Start a conversation by typing a message below.</p>
      </div>
    </div>
  );
}

// =============================================================================
// Main Chat Content Component
// =============================================================================

function ChatContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // Get initial session ID from URL query param
  const initialSessionId = searchParams.get('session') ?? undefined;

  // Initialize WebSocket connection with chat hook
  const {
    messages,
    connected,
    running,
    claudeSessionId,
    availableSessions,
    pendingPermission,
    pendingQuestion,
    loadingSession,
    chatSettings,
    sendMessage,
    stopChat,
    clearChat,
    loadSession,
    approvePermission,
    answerQuestion,
    updateSettings,
    inputRef,
    messagesEndRef,
  } = useChatWebSocket({ initialSessionId });

  // Update URL when claudeSessionId changes
  useEffect(() => {
    const currentSessionParam = searchParams.get('session');

    if (claudeSessionId && claudeSessionId !== currentSessionParam) {
      // Update URL with new session ID
      router.replace(`/chat?session=${claudeSessionId}`, { scroll: false });
    } else if (!claudeSessionId && currentSessionParam) {
      // Clear session from URL if no active session
      router.replace('/chat', { scroll: false });
    }
  }, [claudeSessionId, searchParams, router]);

  // Handle loading a session
  const handleLoadSession = useCallback(
    (sessionId: string) => {
      loadSession(sessionId);
    },
    [loadSession]
  );

  // Handle new chat button
  const handleNewChat = useCallback(() => {
    clearChat();
    router.replace('/chat', { scroll: false });
  }, [clearChat, router]);

  // Determine connection status for indicator
  const status: ConnectionStatus = !connected
    ? 'disconnected'
    : loadingSession
      ? 'loading'
      : running
        ? 'processing'
        : 'connected';

  // Track if user is near bottom for auto-scroll
  const isNearBottomRef = useRef(true);

  // Auto-scroll to bottom when messages change, but only if user is near bottom
  // biome-ignore lint/correctness/useExhaustiveDependencies: We intentionally trigger on messages.length changes
  useEffect(() => {
    if (isNearBottomRef.current && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, messagesEndRef]);

  // Handle scroll to detect if user is near bottom
  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const threshold = 100; // pixels from bottom
    const isNearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < threshold;
    isNearBottomRef.current = isNearBottom;
  }, []);

  // Memoize grouped messages to avoid recalculating on every render
  const groupedMessages = useMemo(() => groupAdjacentToolCalls(messages), [messages]);

  return (
    <div className="flex h-[calc(100svh-24px)] flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Chat with Claude</h1>
          <StatusDot status={status} />
        </div>
        <div className="flex items-center gap-2">
          <SessionPicker
            sessions={availableSessions}
            currentSessionId={claudeSessionId}
            onLoadSession={handleLoadSession}
            disabled={running}
          />
          <Button variant="outline" size="sm" onClick={handleNewChat} disabled={running}>
            <Plus className="mr-1.5 h-4 w-4" />
            New Chat
          </Button>
        </div>
      </div>

      {/* Message List */}
      <ScrollArea className="flex-1" onScroll={handleScroll}>
        <div className="p-4 space-y-2">
          {messages.length === 0 && !running && !loadingSession && <EmptyState />}

          {loadingSession && messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center p-8">
              <div className="flex items-center gap-2 text-muted-foreground">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                <span className="text-sm">Loading session...</span>
              </div>
            </div>
          )}

          {groupedMessages.map((item) => (
            <GroupedMessageItemRenderer key={item.id} item={item} />
          ))}

          {running && <LoadingIndicator className="py-4" />}

          <div ref={messagesEndRef} className="h-px" />
        </div>
      </ScrollArea>

      {/* Input Section with Prompts */}
      <div className="border-t">
        {/* Inline Prompts (above chat input) */}
        <PermissionPrompt permission={pendingPermission} onApprove={approvePermission} />
        <QuestionPrompt question={pendingQuestion} onAnswer={answerQuestion} />

        {/* Chat Input */}
        <ChatInput
          onSend={sendMessage}
          onStop={stopChat}
          disabled={!connected}
          running={running}
          inputRef={inputRef}
          placeholder={running ? 'Claude is thinking...' : 'Type a message...'}
          settings={chatSettings}
          onSettingsChange={updateSettings}
        />
        {claudeSessionId && (
          <div className="px-4 pb-2 text-xs text-muted-foreground">
            Claude CLI Session: {claudeSessionId.slice(0, 16)}...
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Page Component with Suspense
// =============================================================================

export default function ChatPage() {
  return (
    <Suspense fallback={<ChatLoading />}>
      <ChatContent />
    </Suspense>
  );
}
