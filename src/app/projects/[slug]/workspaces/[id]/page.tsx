'use client';

import { GitBranch, PanelRight } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { GroupedMessageItemRenderer, LoadingIndicator } from '@/components/agent-activity';
import { ChatInput, PermissionPrompt, QuestionPrompt, useChatWebSocket } from '@/components/chat';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  MainViewContent,
  MainViewTabBar,
  RightPanel,
  useWorkspacePanel,
  WorkspacePanelProvider,
} from '@/components/workspace';
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
// Toggle Right Panel Button
// =============================================================================

function ToggleRightPanelButton() {
  const { rightPanelVisible, toggleRightPanel } = useWorkspacePanel();

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleRightPanel}
      className="h-8 w-8"
      title={rightPanelVisible ? 'Hide right panel' : 'Show right panel'}
    >
      <PanelRight className={cn('h-4 w-4', rightPanelVisible && 'text-primary')} />
    </Button>
  );
}

// =============================================================================
// Chat Content Component (extracted for use with MainViewContent)
// =============================================================================

interface ChatContentProps {
  messages: ReturnType<typeof useChatWebSocket>['messages'];
  running: boolean;
  loadingSession: boolean;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  handleScroll: (event: React.UIEvent<HTMLDivElement>) => void;
  pendingPermission: ReturnType<typeof useChatWebSocket>['pendingPermission'];
  pendingQuestion: ReturnType<typeof useChatWebSocket>['pendingQuestion'];
  approvePermission: ReturnType<typeof useChatWebSocket>['approvePermission'];
  answerQuestion: ReturnType<typeof useChatWebSocket>['answerQuestion'];
  connected: boolean;
  sendMessage: ReturnType<typeof useChatWebSocket>['sendMessage'];
  stopChat: ReturnType<typeof useChatWebSocket>['stopChat'];
  inputRef: ReturnType<typeof useChatWebSocket>['inputRef'];
  chatSettings: ReturnType<typeof useChatWebSocket>['chatSettings'];
  updateSettings: ReturnType<typeof useChatWebSocket>['updateSettings'];
  claudeSessionId: string | null;
}

function ChatContent({
  messages,
  running,
  loadingSession,
  messagesEndRef,
  handleScroll,
  pendingPermission,
  pendingQuestion,
  approvePermission,
  answerQuestion,
  connected,
  sendMessage,
  stopChat,
  inputRef,
  chatSettings,
  updateSettings,
  claudeSessionId,
}: ChatContentProps) {
  const groupedMessages = useMemo(() => groupAdjacentToolCalls(messages), [messages]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
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
// Main Workspace Chat Component
// =============================================================================

function WorkspaceChatContent() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;
  const workspaceId = params.id as string;

  const { rightPanelVisible } = useWorkspacePanel();

  // Fetch workspace details
  const { data: workspace, isLoading: workspaceLoading } = trpc.workspace.get.useQuery(
    { id: workspaceId },
    { refetchInterval: 10_000 }
  );

  // Fetch Claude sessions for this workspace
  const { data: claudeSessions, isLoading: sessionsLoading } =
    trpc.session.listClaudeSessions.useQuery({ workspaceId }, { refetchInterval: 5000 });

  // Track selected session locally for immediate UI feedback
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const utils = trpc.useUtils();

  // Create session mutation
  const createSession = trpc.session.createClaudeSession.useMutation({
    onSuccess: () => {
      utils.session.listClaudeSessions.invalidate({ workspaceId });
    },
  });

  // Delete session mutation
  const deleteSession = trpc.session.deleteClaudeSession.useMutation({
    onSuccess: () => {
      utils.session.listClaudeSessions.invalidate({ workspaceId });
    },
  });

  // Get the first session (or most recent) to auto-load
  const initialSessionId = claudeSessions?.[0]?.id;

  // Initialize selectedSessionId when sessions first load
  useEffect(() => {
    if (initialSessionId && selectedSessionId === null) {
      setSelectedSessionId(initialSessionId);
    }
  }, [initialSessionId, selectedSessionId]);

  // Initialize WebSocket connection with chat hook
  const {
    messages,
    connected,
    running,
    claudeSessionId,
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

  // Load session when sessions are fetched and we have one with history
  useEffect(() => {
    if (initialSessionId && !claudeSessionId && !loadingSession) {
      // Find the session and only load if it has an actual Claude session ID
      // (meaning it has history to load). New sessions won't have one yet.
      const session = claudeSessions?.find((s) => s.id === initialSessionId);
      if (session?.claudeSessionId) {
        loadSession(session.claudeSessionId);
      }
    }
  }, [initialSessionId, claudeSessionId, loadingSession, loadSession, claudeSessions]);

  // Handle selecting a session by TRPC session ID
  const handleSelectSession = useCallback(
    (sessionId: string) => {
      // Update selected session immediately for UI feedback
      setSelectedSessionId(sessionId);

      // Find the session and load it using the claudeSessionId
      const session = claudeSessions?.find((s) => s.id === sessionId);
      if (session?.claudeSessionId) {
        loadSession(session.claudeSessionId);
      } else {
        // Session exists but has no claudeSessionId - it's a new session with no history
        // Just clear the chat to show empty state
        clearChat();
      }
    },
    [loadSession, claudeSessions, clearChat]
  );

  // Handle closing/deleting a session
  const handleCloseSession = useCallback(
    (sessionId: string) => {
      if (!claudeSessions || claudeSessions.length === 0) {
        return;
      }

      // Find the session being closed
      const sessionIndex = claudeSessions.findIndex((s) => s.id === sessionId);
      if (sessionIndex === -1) {
        return;
      }

      const isSelectedSession = sessionId === selectedSessionId;

      // Delete the session
      deleteSession.mutate({ id: sessionId });

      // If closing the selected session, switch to an adjacent one
      if (isSelectedSession && claudeSessions.length > 1) {
        // Prefer next session, fallback to previous
        const nextSession = claudeSessions[sessionIndex + 1] ?? claudeSessions[sessionIndex - 1];
        setSelectedSessionId(nextSession?.id ?? null);
        if (nextSession?.claudeSessionId) {
          loadSession(nextSession.claudeSessionId);
        } else {
          clearChat();
        }
      } else if (claudeSessions.length === 1) {
        // Closing the last session
        setSelectedSessionId(null);
        clearChat();
      }
    },
    [claudeSessions, selectedSessionId, deleteSession, loadSession, clearChat]
  );

  // Handle new chat button - creates a new session for this workspace
  const handleNewChat = useCallback(() => {
    createSession.mutate(
      {
        workspaceId,
        workflow: 'explore',
        model: 'sonnet',
      },
      {
        onSuccess: () => {
          // Clear chat after session is created - the new session has no history to load
          clearChat();
        },
      }
    );
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

  // Find the running session ID (still needs to be derived from claudeSessionId)
  const runningSessionId = running
    ? claudeSessions?.find((s) => s.claudeSessionId === claudeSessionId)?.id
    : undefined;

  return (
    <div className="flex h-[calc(100svh-24px)] flex-col overflow-hidden">
      {/* Header: Branch name, status, and toggle button */}
      <div className="flex items-center justify-between px-4 py-2 border-b">
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
        <ToggleRightPanelButton />
      </div>

      {/* Main Content Area: Two-column layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Panel: Session tabs + Main View Content */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Tab bar */}
          <div className="px-4 py-2 border-b">
            <MainViewTabBar
              sessions={claudeSessions}
              currentSessionId={selectedSessionId}
              runningSessionId={runningSessionId}
              onSelectSession={handleSelectSession}
              onCreateSession={handleNewChat}
              onCloseSession={handleCloseSession}
              disabled={running || createSession.isPending || deleteSession.isPending}
            />
          </div>

          {/* Main View Content */}
          <MainViewContent workspaceId={workspaceId} className="flex-1">
            <ChatContent
              messages={messages}
              running={running}
              loadingSession={loadingSession}
              messagesEndRef={messagesEndRef}
              handleScroll={handleScroll}
              pendingPermission={pendingPermission}
              pendingQuestion={pendingQuestion}
              approvePermission={approvePermission}
              answerQuestion={answerQuestion}
              connected={connected}
              sendMessage={sendMessage}
              stopChat={stopChat}
              inputRef={inputRef}
              chatSettings={chatSettings}
              updateSettings={updateSettings}
              claudeSessionId={claudeSessionId}
            />
          </MainViewContent>
        </div>

        {/* Right Panel (conditionally rendered, fixed width) */}
        {rightPanelVisible && (
          <div className="w-[400px] border-l flex-shrink-0">
            <RightPanel workspaceId={workspaceId} />
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Page Component with Suspense and Provider
// =============================================================================

export default function WorkspaceDetailPage() {
  return (
    <WorkspacePanelProvider>
      <Suspense fallback={<ChatLoading />}>
        <WorkspaceChatContent />
      </Suspense>
    </WorkspacePanelProvider>
  );
}
