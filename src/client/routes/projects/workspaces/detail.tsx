import {
  AppWindow,
  Archive,
  ArrowDown,
  CheckCircle2,
  Circle,
  GitBranch,
  GitPullRequest,
  Loader2,
  PanelRight,
  XCircle,
} from 'lucide-react';
import { memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { KeyboardStateProvider } from '@/components/agent-activity';
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

import { useAutoScroll, useSessionManagement, useWorkspaceData } from './use-workspace-detail';
import { ArchivingOverlay, InitializationOverlay } from './workspace-overlays';

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

  // Memoize onHeightChange to prevent recreating on every render
  const handleHeightChange = useCallback(() => {
    // Keep messages scrolled to bottom when input area grows
    // Use scrollTo with instant to override CSS smooth scrolling
    if (isNearBottom && viewportRef.current) {
      viewportRef.current.scrollTo({
        top: viewportRef.current.scrollHeight,
        behavior: 'instant',
      });
    }
  }, [isNearBottom, viewportRef]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: focus input on click is UX enhancement, not primary interaction
    // biome-ignore lint/a11y/noStaticElementInteractions: focus input on click is UX enhancement
    <div className="relative flex h-full flex-col overflow-hidden" onClick={handleChatClick}>
      {/* Virtualized Message List */}
      <div ref={viewportRef} className="flex-1 min-h-0 overflow-y-auto">
        <KeyboardStateProvider>
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
        </KeyboardStateProvider>
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
          onHeightChange={handleHeightChange}
        />
      </div>
    </div>
  );
});

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

  // Show loading while fetching workspace (but not sessions - they can load in background)
  if (workspaceLoading) {
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
                <RightPanel workspaceId={workspaceId} messages={messages} />
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
