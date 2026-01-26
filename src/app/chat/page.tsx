'use client';

import { Plus } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect } from 'react';

import {
  ChatInput,
  MessageList,
  PermissionModal,
  QuestionModal,
  SessionPicker,
  useChatWebSocket,
} from '@/components/chat';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

type ConnectionStatus = 'connected' | 'processing' | 'disconnected';

// =============================================================================
// Helper Components
// =============================================================================

/**
 * Status indicator dot that shows connection state.
 * - Green: connected and idle
 * - Yellow: processing (running)
 * - Red: disconnected
 */
function StatusDot({ status }: { status: ConnectionStatus }) {
  return (
    <div
      className={cn(
        'h-2.5 w-2.5 rounded-full',
        status === 'connected' && 'bg-green-500',
        status === 'processing' && 'bg-yellow-500 animate-pulse',
        status === 'disconnected' && 'bg-red-500'
      )}
      title={
        status === 'connected'
          ? 'Connected'
          : status === 'processing'
            ? 'Processing...'
            : 'Disconnected'
      }
    />
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
    sendMessage,
    clearChat,
    loadSession,
    approvePermission,
    answerQuestion,
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
    : running
      ? 'processing'
      : 'connected';

  return (
    <div className="flex h-full flex-col">
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
      <MessageList
        messages={messages}
        running={running}
        messagesEndRef={messagesEndRef}
        className="flex-1"
      />

      {/* Chat Input */}
      <div className="border-t">
        <ChatInput
          onSend={sendMessage}
          disabled={!connected}
          running={running}
          inputRef={inputRef}
          placeholder={running ? 'Claude is thinking...' : 'Type a message...'}
        />
        {claudeSessionId && (
          <div className="px-4 pb-2 text-xs text-muted-foreground">
            Claude CLI Session: {claudeSessionId.slice(0, 16)}...
          </div>
        )}
      </div>

      {/* Permission Modal Overlay */}
      <PermissionModal permission={pendingPermission} onApprove={approvePermission} />

      {/* Question Modal Overlay */}
      <QuestionModal question={pendingQuestion} onAnswer={answerQuestion} />
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
