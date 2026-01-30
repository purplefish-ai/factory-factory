import {
  AlertTriangle,
  AppWindow,
  Archive,
  ArrowDown,
  CheckCircle2,
  Circle,
  GitBranch,
  GitPullRequest,
  Loader2,
  PanelRight,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';

import {
  ChatInput,
  PermissionPrompt,
  QuestionPrompt,
  QueuedMessages,
  useChatWebSocket,
  VirtualizedMessageList,
} from '@/components/chat';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  QuickActionsMenu,
  RightPanel,
  useWorkspacePanel,
  WorkspaceContentView,
  WorkspacePanelProvider,
} from '@/components/workspace';
import { Loading } from '@/frontend/components/loading';
import { trpc } from '@/frontend/lib/trpc';
import { groupAdjacentToolCalls } from '@/lib/claude-types';
import { cn } from '@/lib/utils';

// =============================================================================
// Helper Components
// =============================================================================

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
// Workspace Initialization Overlay
// =============================================================================

interface InitializationOverlayProps {
  workspaceId: string;
  initStatus: 'PENDING' | 'INITIALIZING' | 'READY' | 'FAILED';
  initErrorMessage: string | null;
  hasStartupScript: boolean;
}

function InitializationOverlay({
  workspaceId,
  initStatus,
  initErrorMessage,
  hasStartupScript,
}: InitializationOverlayProps) {
  const utils = trpc.useUtils();

  const retryInit = trpc.workspace.retryInit.useMutation({
    onSuccess: () => {
      utils.workspace.getInitStatus.invalidate({ id: workspaceId });
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const isFailed = initStatus === 'FAILED';
  const isInitializing = initStatus === 'INITIALIZING';

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4 p-8 max-w-md text-center">
        {isFailed ? (
          <>
            <div className="rounded-full bg-destructive/10 p-3">
              <AlertTriangle className="h-8 w-8 text-destructive" />
            </div>
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">Workspace Setup Failed</h2>
              <p className="text-sm text-muted-foreground">
                {initErrorMessage || 'An error occurred while setting up this workspace.'}
              </p>
            </div>
            <Button
              onClick={() => retryInit.mutate({ id: workspaceId })}
              disabled={retryInit.isPending}
            >
              {retryInit.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Retrying...
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Retry Setup
                </>
              )}
            </Button>
          </>
        ) : (
          <>
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">Setting up workspace...</h2>
              <p className="text-sm text-muted-foreground">
                {isInitializing && hasStartupScript
                  ? 'Running startup script. This may take a few minutes.'
                  : 'Creating git worktree and preparing your workspace.'}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Archiving Overlay
// =============================================================================

function ArchivingOverlay() {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4 p-8 max-w-md text-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Archiving workspace...</h2>
          <p className="text-sm text-muted-foreground">
            Cleaning up worktree and archiving this workspace.
          </p>
        </div>
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
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" onClick={toggleRightPanel} className="h-8 w-8">
          <PanelRight className={cn('h-4 w-4', rightPanelVisible && 'text-primary')} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{rightPanelVisible ? 'Hide right panel' : 'Show right panel'}</TooltipContent>
    </Tooltip>
  );
}

// =============================================================================
// Chat Content Component (extracted for use with MainViewContent)
// =============================================================================

interface ChatContentProps {
  messages: ReturnType<typeof useChatWebSocket>['messages'];
  running: boolean;
  stopping: boolean;
  loadingSession: boolean;
  startingSession: boolean;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  isNearBottom: boolean;
  scrollToBottom: () => void;
  onScroll: () => void;
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
  inputDraft: ReturnType<typeof useChatWebSocket>['inputDraft'];
  setInputDraft: ReturnType<typeof useChatWebSocket>['setInputDraft'];
  queuedMessages: ReturnType<typeof useChatWebSocket>['queuedMessages'];
  removeQueuedMessage: ReturnType<typeof useChatWebSocket>['removeQueuedMessage'];
  /** Database session ID for detecting session changes (auto-focus) */
  selectedDbSessionId: string | null;
}

/**
 * ChatContent component - memoized to prevent re-renders from parent state changes.
 * Uses virtualization for efficient rendering of long message lists.
 */
const ChatContent = memo(function ChatContent({
  messages,
  running,
  stopping,
  loadingSession,
  startingSession,
  messagesEndRef,
  viewportRef,
  isNearBottom,
  scrollToBottom,
  onScroll,
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
  inputDraft,
  setInputDraft,
  queuedMessages,
  removeQueuedMessage,
  selectedDbSessionId,
}: ChatContentProps) {
  // Group adjacent tool calls for display (memoized)
  const groupedMessages = useMemo(() => groupAdjacentToolCalls(messages), [messages]);

  // Focus input when clicking anywhere in the chat area (but not on interactive elements)
  const handleChatClick = useCallback(
    (e: React.MouseEvent) => {
      // Don't steal focus from interactive elements (buttons, inputs, etc.)
      const target = e.target as HTMLElement;
      if (
        target.closest(
          'button, input, textarea, select, [role="button"], [data-radix-collection-item]'
        )
      ) {
        return;
      }
      if (inputRef?.current && !running) {
        inputRef.current.focus();
      }
    },
    [inputRef, running]
  );

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: focus input on click is UX enhancement, not primary interaction
    // biome-ignore lint/a11y/noStaticElementInteractions: focus input on click is UX enhancement
    <div className="relative flex h-full flex-col overflow-hidden" onClick={handleChatClick}>
      {/* Virtualized Message List */}
      <div ref={viewportRef} className="flex-1 min-h-0 overflow-y-auto scroll-smooth">
        <VirtualizedMessageList
          messages={groupedMessages}
          running={running}
          startingSession={startingSession}
          loadingSession={loadingSession}
          scrollContainerRef={viewportRef}
          onScroll={onScroll}
          messagesEndRef={messagesEndRef}
          isNearBottom={isNearBottom}
        />
      </div>

      {/* Scroll to Bottom Button */}
      {!isNearBottom && (
        <div className="absolute bottom-28 left-1/2 -translate-x-1/2 z-10">
          <Button
            variant="secondary"
            size="sm"
            onClick={scrollToBottom}
            className="rounded-full shadow-lg"
          >
            <ArrowDown className="h-4 w-4 mr-1" />
            Scroll to bottom
          </Button>
        </div>
      )}

      {/* Input Section with Queue and Prompts */}
      <div className="border-t">
        <QueuedMessages messages={queuedMessages} onRemove={removeQueuedMessage} />
        <PermissionPrompt permission={pendingPermission} onApprove={approvePermission} />
        <QuestionPrompt question={pendingQuestion} onAnswer={answerQuestion} />

        <ChatInput
          onSend={sendMessage}
          onStop={stopChat}
          disabled={!connected}
          running={running}
          stopping={stopping}
          inputRef={inputRef}
          placeholder={
            stopping ? 'Stopping...' : running ? 'Message will be queued...' : 'Type a message...'
          }
          settings={chatSettings}
          onSettingsChange={updateSettings}
          sessionId={selectedDbSessionId}
          value={inputDraft}
          onChange={setInputDraft}
          onHeightChange={() => {
            // Keep messages scrolled to bottom when input area grows
            // Use scrollTo with instant to override CSS smooth scrolling
            if (isNearBottom && viewportRef.current) {
              viewportRef.current.scrollTo({
                top: viewportRef.current.scrollHeight,
                behavior: 'instant',
              });
            }
          }}
        />
      </div>
    </div>
  );
});

// =============================================================================
// Custom Hooks for Workspace Page
// =============================================================================

interface UseWorkspaceDataOptions {
  workspaceId: string;
}

function useWorkspaceData({ workspaceId }: UseWorkspaceDataOptions) {
  // Increased staleTime to reduce unnecessary re-renders from background fetches
  const { data: workspace, isLoading: workspaceLoading } = trpc.workspace.get.useQuery(
    { id: workspaceId },
    {
      refetchInterval: 30_000, // Poll every 30s instead of 10s
      staleTime: 15_000, // Data considered fresh for 15s
      refetchOnWindowFocus: false, // Don't refetch on tab focus
    }
  );

  const { data: claudeSessions, isLoading: sessionsLoading } =
    trpc.session.listClaudeSessions.useQuery(
      { workspaceId },
      {
        refetchInterval: 10_000, // Poll every 10s instead of 5s
        staleTime: 5000, // Data considered fresh for 5s
        refetchOnWindowFocus: false,
      }
    );

  const { data: maxSessions } = trpc.session.getMaxSessionsPerWorkspace.useQuery();

  const { data: workflows } = trpc.session.listWorkflows.useQuery(undefined, {
    enabled: claudeSessions !== undefined && claudeSessions.length === 0,
  });

  const { data: recommendedWorkflow } = trpc.session.getRecommendedWorkflow.useQuery(
    { workspaceId },
    { enabled: claudeSessions !== undefined && claudeSessions.length === 0 }
  );

  const firstSession = claudeSessions?.[0];
  // Database record ID for the first session
  const initialDbSessionId = firstSession?.id;

  return {
    workspace,
    workspaceLoading,
    claudeSessions,
    sessionsLoading,
    workflows,
    recommendedWorkflow,
    initialDbSessionId,
    maxSessions,
  };
}

interface UseSessionManagementOptions {
  workspaceId: string;
  slug: string;
  claudeSessions: ReturnType<typeof useWorkspaceData>['claudeSessions'];
  sendMessage: (text: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  selectedDbSessionId: string | null;
  setSelectedDbSessionId: React.Dispatch<React.SetStateAction<string | null>>;
}

function useSessionManagement({
  workspaceId,
  slug,
  claudeSessions,
  sendMessage,
  inputRef,
  selectedDbSessionId,
  setSelectedDbSessionId,
}: UseSessionManagementOptions) {
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  // Ref to store pending quick action prompt (to send after session is ready)
  const pendingQuickActionRef = useRef<{ dbSessionId: string; prompt: string } | null>(null);

  // Effect to send pending quick action prompt when session is selected
  useEffect(() => {
    const pending = pendingQuickActionRef.current;
    if (pending && pending.dbSessionId === selectedDbSessionId) {
      pendingQuickActionRef.current = null;
      sendMessage(pending.prompt);
    }
  }, [selectedDbSessionId, sendMessage]);

  const createSession = trpc.session.createClaudeSession.useMutation({
    onSuccess: () => {
      utils.session.listClaudeSessions.invalidate({ workspaceId });
    },
  });

  const deleteSession = trpc.session.deleteClaudeSession.useMutation({
    onSuccess: () => {
      utils.session.listClaudeSessions.invalidate({ workspaceId });
    },
  });

  const archiveWorkspace = trpc.workspace.archive.useMutation({
    onSuccess: () => {
      navigate(`/projects/${slug}/workspaces`);
    },
  });

  const openInIde = trpc.workspace.openInIde.useMutation({
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const { data: availableIdesData } = trpc.workspace.getAvailableIdes.useQuery();
  const availableIdes = availableIdesData?.ides ?? [];
  const preferredIde = availableIdesData?.preferredIde ?? 'cursor';

  const handleSelectSession = useCallback(
    (dbSessionId: string) => {
      // Only update the selected session ID here.
      // The WebSocket connection is keyed by dbSessionId, so changing it will
      // automatically reconnect and load the correct session.
      setSelectedDbSessionId(dbSessionId);
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    [inputRef, setSelectedDbSessionId]
  );

  const handleCloseSession = useCallback(
    (dbSessionId: string) => {
      if (!claudeSessions || claudeSessions.length === 0) {
        return;
      }

      const sessionIndex = claudeSessions.findIndex((s) => s.id === dbSessionId);
      if (sessionIndex === -1) {
        return;
      }

      const isSelectedSession = dbSessionId === selectedDbSessionId;
      deleteSession.mutate({ id: dbSessionId });

      if (isSelectedSession && claudeSessions.length > 1) {
        // Select the next or previous session
        // The WebSocket will automatically reconnect and load the new session
        const nextSession = claudeSessions[sessionIndex + 1] ?? claudeSessions[sessionIndex - 1];
        setSelectedDbSessionId(nextSession?.id ?? null);
      } else if (claudeSessions.length === 1) {
        // No more sessions - clear selection
        setSelectedDbSessionId(null);
      }
    },
    [claudeSessions, selectedDbSessionId, deleteSession, setSelectedDbSessionId]
  );

  // Generate next available "Chat N" name based on existing sessions
  const getNextChatName = useCallback(() => {
    const existingNumbers = (claudeSessions ?? [])
      .map((s) => {
        const match = s.name?.match(/^Chat (\d+)$/);
        return match ? Number.parseInt(match[1], 10) : 0;
      })
      .filter((n) => n > 0);
    const nextNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
    return `Chat ${nextNumber}`;
  }, [claudeSessions]);

  const handleWorkflowSelect = useCallback(
    (workflowId: string) => {
      createSession.mutate(
        { workspaceId, workflow: workflowId, model: 'sonnet', name: getNextChatName() },
        {
          onSuccess: (session) => {
            // Setting the new session ID triggers WebSocket reconnection automatically
            setSelectedDbSessionId(session.id);
          },
        }
      );
    },
    [createSession, workspaceId, getNextChatName, setSelectedDbSessionId]
  );

  const handleNewChat = useCallback(() => {
    const name = getNextChatName();

    createSession.mutate(
      { workspaceId, workflow: 'followup', model: 'sonnet', name },
      {
        onSuccess: (session) => {
          // Setting the new session ID triggers WebSocket reconnection automatically
          setSelectedDbSessionId(session.id);
        },
      }
    );
  }, [createSession, workspaceId, getNextChatName, setSelectedDbSessionId]);

  const handleQuickAction = useCallback(
    (name: string, prompt: string) => {
      createSession.mutate(
        { workspaceId, workflow: 'followup', name, model: 'sonnet' },
        {
          onSuccess: (session) => {
            // Store the pending prompt to be sent once the session state settles
            pendingQuickActionRef.current = { dbSessionId: session.id, prompt };
            // Setting the new session ID triggers WebSocket reconnection automatically
            setSelectedDbSessionId(session.id);
          },
        }
      );
    },
    [createSession, workspaceId, setSelectedDbSessionId]
  );

  return {
    createSession,
    deleteSession,
    archiveWorkspace,
    openInIde,
    availableIdes,
    preferredIde,
    handleSelectSession,
    handleCloseSession,
    handleWorkflowSelect,
    handleNewChat,
    handleQuickAction,
  };
}

/**
 * Hook for managing auto-scroll behavior with RAF throttling.
 * Optimized for virtualized lists - doesn't require contentRef.
 */
function useAutoScroll(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  inputRef: React.RefObject<HTMLTextAreaElement | null>
) {
  const [isNearBottom, setIsNearBottom] = useState(true);
  const isNearBottomRef = useRef(true);
  // Track if we're currently animating a scroll-to-bottom to prevent flicker
  const isScrollingToBottomRef = useRef(false);
  // RAF throttle flag
  const rafPendingRef = useRef(false);

  // Throttled scroll handler using requestAnimationFrame
  const onScroll = useCallback(() => {
    // Don't update state while animating scroll-to-bottom (prevents flicker)
    if (isScrollingToBottomRef.current) {
      return;
    }

    // Skip if we already have a pending RAF
    if (rafPendingRef.current) {
      return;
    }

    rafPendingRef.current = true;
    requestAnimationFrame(() => {
      rafPendingRef.current = false;

      const viewport = viewportRef.current;
      if (!viewport) {
        return;
      }

      const scrollThreshold = 100;
      const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      const nearBottom = distanceFromBottom < scrollThreshold;

      // Only update state if it changed
      if (nearBottom !== isNearBottomRef.current) {
        isNearBottomRef.current = nearBottom;
        setIsNearBottom(nearBottom);
      }
    });
  }, [viewportRef]);

  const scrollToBottom = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    // Set flag to prevent onScroll from causing flicker during animation
    isScrollingToBottomRef.current = true;
    setIsNearBottom(true);
    isNearBottomRef.current = true;

    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: 'smooth',
    });

    // Focus the input for convenience
    inputRef.current?.focus();

    // Clear the flag after animation completes (smooth scroll typically ~300-500ms)
    setTimeout(() => {
      isScrollingToBottomRef.current = false;
    }, 500);
  }, [viewportRef, inputRef]);

  return { onScroll, isNearBottom, scrollToBottom };
}

// =============================================================================
// Main Workspace Chat Component
// =============================================================================

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: main workspace component with multiple features
function WorkspaceChatContent() {
  const { slug = '', id: workspaceId = '' } = useParams<{ slug: string; id: string }>();
  const navigate = useNavigate();

  // Fetch workspace and session data
  const {
    workspace,
    workspaceLoading,
    claudeSessions,
    sessionsLoading,
    workflows,
    recommendedWorkflow,
    initialDbSessionId,
    maxSessions,
  } = useWorkspaceData({ workspaceId: workspaceId });

  const { rightPanelVisible } = useWorkspacePanel();

  // Query init status to show initialization overlay
  const { data: initStatus } = trpc.workspace.getInitStatus.useQuery(
    { id: workspaceId },
    {
      // Poll while not ready
      refetchInterval: (query) => {
        const status = query.state.data?.initStatus;
        return status === 'READY' || status === 'FAILED' ? false : 1000;
      },
    }
  );

  // Manage selected session state here so it's available for useChatWebSocket
  const [selectedDbSessionId, setSelectedDbSessionId] = useState<string | null>(null);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);

  // Initialize selectedDbSessionId when sessions first load
  useEffect(() => {
    if (initialDbSessionId && selectedDbSessionId === null) {
      setSelectedDbSessionId(initialDbSessionId);
    }
  }, [initialDbSessionId, selectedDbSessionId]);

  // Initialize WebSocket connection with chat hook
  const {
    messages,
    connected,
    running,
    stopping,
    pendingPermission,
    pendingQuestion,
    loadingSession,
    startingSession,
    chatSettings,
    inputDraft,
    queuedMessages,
    sendMessage,
    stopChat,
    approvePermission,
    answerQuestion,
    updateSettings,
    setInputDraft,
    removeQueuedMessage,
    inputRef,
    messagesEndRef,
  } = useChatWebSocket({
    workingDir: workspace?.worktreePath ?? undefined,
    dbSessionId: selectedDbSessionId,
  });

  // Session management
  const {
    createSession,
    deleteSession,
    archiveWorkspace,
    openInIde,
    availableIdes,
    preferredIde,
    handleSelectSession,
    handleCloseSession,
    handleWorkflowSelect,
    handleNewChat,
    handleQuickAction,
  } = useSessionManagement({
    workspaceId: workspaceId,
    slug: slug,
    claudeSessions,
    sendMessage,
    inputRef,
    selectedDbSessionId,
    setSelectedDbSessionId,
  });

  // Ref for scroll handling (virtualized list manages its own content)
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll behavior with RAF throttling
  const { onScroll, isNearBottom, scrollToBottom } = useAutoScroll(viewportRef, inputRef);

  // Show loading while fetching workspace and sessions
  if (workspaceLoading || sessionsLoading) {
    return <Loading message="Loading workspace..." />;
  }

  if (!workspace) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-destructive">Workspace not found</p>
        <Button variant="outline" onClick={() => navigate(`/projects/${slug}/workspaces`)}>
          Back to workspaces
        </Button>
      </div>
    );
  }

  // The running session is always the currently selected session
  const runningSessionId = running && selectedDbSessionId ? selectedDbSessionId : undefined;

  // Check if workspace is still initializing
  const isInitializing = initStatus && initStatus.initStatus !== 'READY';

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* Initialization Overlay - shown while workspace is being set up */}
      {isInitializing && initStatus && (
        <InitializationOverlay
          workspaceId={workspaceId}
          initStatus={initStatus.initStatus}
          initErrorMessage={initStatus.initErrorMessage}
          hasStartupScript={initStatus.hasStartupScript}
        />
      )}

      {/* Archiving Overlay - shown while workspace is being archived */}
      {archiveWorkspace.isPending && <ArchivingOverlay />}

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
          {/* PR Link with CI Status */}
          {workspace.prUrl && workspace.prNumber && workspace.prState !== 'NONE' && (
            <a
              href={workspace.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full transition-colors text-sm font-medium ${
                workspace.prState === 'MERGED'
                  ? 'bg-purple-500/25 text-purple-700 dark:text-purple-300 hover:bg-purple-500/35'
                  : 'bg-purple-500/15 text-purple-600 dark:text-purple-400 hover:bg-purple-500/25'
              }`}
            >
              <GitPullRequest className="h-4 w-4" />
              <span>#{workspace.prNumber}</span>
              {workspace.prState === 'MERGED' ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-purple-500" />
                  <span className="text-xs">Merged</span>
                </>
              ) : (
                <>
                  {workspace.prCiStatus === 'SUCCESS' && (
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                  )}
                  {workspace.prCiStatus === 'FAILURE' && (
                    <XCircle className="h-4 w-4 text-red-500" />
                  )}
                  {workspace.prCiStatus === 'PENDING' && (
                    <Circle className="h-4 w-4 text-yellow-500 animate-pulse" />
                  )}
                </>
              )}
            </a>
          )}
        </div>
        <div className="flex items-center gap-1">
          <QuickActionsMenu
            onExecuteAgent={(action) => {
              if (action.content) {
                handleQuickAction(action.name, action.content);
              }
            }}
            disabled={running || createSession.isPending}
          />
          {availableIdes.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => openInIde.mutate({ id: workspaceId })}
                  disabled={openInIde.isPending || !workspace.worktreePath}
                >
                  {openInIde.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <AppWindow className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Open in {availableIdes.find((ide) => ide.id === preferredIde)?.name ?? 'IDE'}
              </TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setArchiveDialogOpen(true)}
                disabled={archiveWorkspace.isPending}
              >
                {archiveWorkspace.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Archive className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {archiveWorkspace.isPending ? 'Archiving...' : 'Archive'}
            </TooltipContent>
          </Tooltip>
          <ToggleRightPanelButton />
        </div>
      </div>

      {/* Main Content Area: Resizable two-column layout */}
      <ResizablePanelGroup
        direction="horizontal"
        className="flex-1 overflow-hidden"
        autoSaveId="workspace-main-panel"
      >
        {/* Left Panel: Session tabs + Main View Content */}
        {/* NOTE: react-resizable-panels v4+ changed its API to use percentage strings (e.g., "70%")
            instead of numbers. Do NOT change these to numbers - it will break panel sizing.
            See: https://github.com/bvaughn/react-resizable-panels/releases/tag/4.0.0 */}
        <ResizablePanel defaultSize="70%" minSize="30%">
          <div className="h-full flex flex-col min-w-0">
            <WorkspaceContentView
              workspaceId={workspaceId}
              claudeSessions={claudeSessions}
              workflows={workflows}
              recommendedWorkflow={recommendedWorkflow}
              selectedSessionId={selectedDbSessionId}
              runningSessionId={runningSessionId}
              running={running}
              isCreatingSession={createSession.isPending}
              isDeletingSession={deleteSession.isPending}
              onWorkflowSelect={handleWorkflowSelect}
              onSelectSession={handleSelectSession}
              onCreateSession={handleNewChat}
              onCloseSession={handleCloseSession}
              maxSessions={maxSessions}
            >
              <ChatContent
                messages={messages}
                running={running}
                stopping={stopping}
                loadingSession={loadingSession}
                startingSession={startingSession}
                messagesEndRef={messagesEndRef}
                viewportRef={viewportRef}
                isNearBottom={isNearBottom}
                scrollToBottom={scrollToBottom}
                onScroll={onScroll}
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
                inputDraft={inputDraft}
                setInputDraft={setInputDraft}
                queuedMessages={queuedMessages}
                removeQueuedMessage={removeQueuedMessage}
                selectedDbSessionId={selectedDbSessionId}
              />
            </WorkspaceContentView>
          </div>
        </ResizablePanel>

        {/* Right Panel: Git/Files + Terminal (conditionally rendered) */}
        {/* NOTE: Panel sizes must be percentage strings for react-resizable-panels v4+ */}
        {rightPanelVisible && (
          <>
            <ResizableHandle />
            <ResizablePanel defaultSize="30%" minSize="15%" maxSize="50%">
              <div className="h-full border-l">
                <RightPanel workspaceId={workspaceId} />
              </div>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>

      <ConfirmDialog
        open={archiveDialogOpen}
        onOpenChange={setArchiveDialogOpen}
        title="Archive Workspace"
        description="Are you sure you want to archive this workspace?"
        confirmText="Archive"
        variant="destructive"
        onConfirm={() => {
          archiveWorkspace.mutate({ id: workspaceId });
          setArchiveDialogOpen(false);
        }}
        isPending={archiveWorkspace.isPending}
      />
    </div>
  );
}

// =============================================================================
// Page Component with Suspense and Provider
// =============================================================================

export default function WorkspaceDetailPage() {
  const { id: workspaceId = '' } = useParams<{ id: string }>();

  return (
    <WorkspacePanelProvider workspaceId={workspaceId}>
      <Suspense fallback={<ChatLoading />}>
        {/* Key by workspaceId to reset all state when switching workspaces.
            Without this, selectedDbSessionId would persist from the previous
            workspace and no session tab would be highlighted. */}
        <WorkspaceChatContent key={workspaceId} />
      </Suspense>
    </WorkspacePanelProvider>
  );
}
