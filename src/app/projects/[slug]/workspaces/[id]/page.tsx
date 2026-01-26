'use client';

import { GitBranch, Plus } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
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
import { Loading } from '@/frontend/components/loading';
import { trpc } from '@/frontend/lib/trpc';
import { groupAdjacentToolCalls } from '@/lib/claude-types';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

type ConnectionStatus = 'connected' | 'processing' | 'disconnected' | 'loading';

// =============================================================================
// Helper Components
// =============================================================================

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
      <output className="sr-only" aria-live="polite">
        {statusText}
      </output>
    </>
  );
}

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
// Main Workspace Chat Component
// =============================================================================

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Chat component with multiple states and handlers
function WorkspaceChatContent() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;
  const workspaceId = params.id as string;

  // Fetch workspace details
  const { data: workspace, isLoading: workspaceLoading } = trpc.workspace.get.useQuery(
    { id: workspaceId },
    { refetchInterval: 10_000 }
  );

  // Fetch Claude sessions for this workspace
  const { data: claudeSessions, isLoading: sessionsLoading } =
    trpc.session.listClaudeSessions.useQuery({ workspaceId }, { refetchInterval: 5000 });

  const utils = trpc.useUtils();

  // Create session mutation
  const createSession = trpc.session.createClaudeSession.useMutation({
    onSuccess: () => {
      utils.session.listClaudeSessions.invalidate({ workspaceId });
    },
  });

  // Get the first session (or most recent) to auto-load
  const initialSessionId = claudeSessions?.[0]?.id;

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

  // Load session when sessions are fetched and we have one
  useEffect(() => {
    if (initialSessionId && !claudeSessionId && !loadingSession) {
      loadSession(initialSessionId);
    }
  }, [initialSessionId, claudeSessionId, loadingSession, loadSession]);

  // Handle loading a session
  const handleLoadSession = useCallback(
    (sessionId: string) => {
      loadSession(sessionId);
    },
    [loadSession]
  );

  // Handle new chat button - creates a new session for this workspace
  const handleNewChat = useCallback(() => {
    clearChat();
    createSession.mutate({
      workspaceId,
      workflow: 'explore',
      model: 'sonnet',
    });
  }, [clearChat, createSession, workspaceId]);

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

  // Auto-scroll to bottom when messages change
  // biome-ignore lint/correctness/useExhaustiveDependencies: We intentionally trigger on messages.length changes
  useEffect(() => {
    if (isNearBottomRef.current && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, messagesEndRef]);

  // Handle scroll to detect if user is near bottom
  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const threshold = 100;
    const isNearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < threshold;
    isNearBottomRef.current = isNearBottom;
  }, []);

  // Memoize grouped messages
  const groupedMessages = useMemo(() => groupAdjacentToolCalls(messages), [messages]);

  // Show loading while fetching workspace and sessions
  if (workspaceLoading || sessionsLoading) {
    return <Loading message="Loading workspace..." />;
  }

  if (!workspace) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-destructive">Workspace not found</p>
        <Button variant="outline" onClick={() => router.push(`/projects/${slug}/workspaces`)}>
          Back to workspaces
        </Button>
      </div>
    );
  }

  // Filter available sessions to only show ones for this workspace
  const workspaceSessions = availableSessions.filter((s) =>
    claudeSessions?.some((cs) => cs.id === s.sessionId)
  );

  return (
    <div className="flex h-[calc(100svh-24px)] flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-3">
          {workspace.branchName ? (
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-muted-foreground" />
              <h1 className="text-lg font-semibold font-mono">{workspace.branchName}</h1>
            </div>
          ) : (
            <h1 className="text-lg font-semibold">{workspace.name}</h1>
          )}
          <StatusDot status={status} />
        </div>
        <div className="flex items-center gap-2">
          <SessionPicker
            sessions={workspaceSessions.length > 0 ? workspaceSessions : availableSessions}
            currentSessionId={claudeSessionId}
            onLoadSession={handleLoadSession}
            disabled={running}
          />
          <Button
            variant="outline"
            size="icon"
            onClick={handleNewChat}
            disabled={running || createSession.isPending}
            title="New Chat"
          >
            <Plus className="h-4 w-4" />
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
        <PermissionPrompt permission={pendingPermission} onApprove={approvePermission} />
        <QuestionPrompt question={pendingQuestion} onAnswer={answerQuestion} />

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
            Session: {claudeSessionId.slice(0, 16)}...
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Page Component with Suspense
// =============================================================================

export default function WorkspaceDetailPage() {
  return (
    <Suspense fallback={<ChatLoading />}>
      <WorkspaceChatContent />
    </Suspense>
  );
}
