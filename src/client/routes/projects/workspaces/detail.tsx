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

import {
  ChatInput,
  PermissionPrompt,
  QuestionPrompt,
  RewindConfirmationDialog,
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
  RunScriptButton,
  RunScriptPortBadge,
  useWorkspacePanel,
  WorkspaceContentView,
  WorkspacePanelProvider,
} from '@/components/workspace';
import { Loading } from '@/frontend/components/loading';
import { trpc } from '@/frontend/lib/trpc';
import type { CommandInfo, TokenStats } from '@/lib/claude-types';
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
  sessionStatus: ReturnType<typeof useChatWebSocket>['sessionStatus'];
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  isNearBottom: boolean;
  scrollToBottom: () => void;
  onScroll: () => void;
  pendingRequest: ReturnType<typeof useChatWebSocket>['pendingRequest'];
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
  inputAttachments: ReturnType<typeof useChatWebSocket>['inputAttachments'];
  setInputAttachments: ReturnType<typeof useChatWebSocket>['setInputAttachments'];
  queuedMessages: ReturnType<typeof useChatWebSocket>['queuedMessages'];
  removeQueuedMessage: ReturnType<typeof useChatWebSocket>['removeQueuedMessage'];
  latestThinking: ReturnType<typeof useChatWebSocket>['latestThinking'];
  pendingMessages: ReturnType<typeof useChatWebSocket>['pendingMessages'];
  isCompacting: ReturnType<typeof useChatWebSocket>['isCompacting'];
  slashCommands: CommandInfo[];
  tokenStats: TokenStats;
  // Rewind files
  rewindPreview: ReturnType<typeof useChatWebSocket>['rewindPreview'];
  startRewindPreview: ReturnType<typeof useChatWebSocket>['startRewindPreview'];
  confirmRewind: ReturnType<typeof useChatWebSocket>['confirmRewind'];
  cancelRewind: ReturnType<typeof useChatWebSocket>['cancelRewind'];
  getUuidForMessageId: ReturnType<typeof useChatWebSocket>['getUuidForMessageId'];
}

/**
 * ChatContent component - memoized to prevent re-renders from parent state changes.
 * Uses virtualization for efficient rendering of long message lists.
 */
const ChatContent = memo(function ChatContent({
  messages,
  sessionStatus,
  messagesEndRef,
  viewportRef,
  isNearBottom,
  scrollToBottom,
  onScroll,
  pendingRequest,
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
  inputAttachments,
  setInputAttachments,
  queuedMessages,
  removeQueuedMessage,
  latestThinking,
  pendingMessages,
  isCompacting,
  slashCommands,
  tokenStats,
  rewindPreview,
  startRewindPreview,
  confirmRewind,
  cancelRewind,
  getUuidForMessageId,
}: ChatContentProps) {
  // Group adjacent tool calls for display (memoized)
  const groupedMessages = useMemo(() => groupAdjacentToolCalls(messages), [messages]);

  // Convert queued messages to Set of IDs for efficient lookup (memoized)
  const queuedMessageIds = useMemo(
    () => new Set(queuedMessages.map((msg) => msg.id)),
    [queuedMessages]
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

  // Derive boolean flags from sessionStatus for components that still use them
  const running = sessionStatus.phase === 'running';
  const stopping = sessionStatus.phase === 'stopping';
  const startingSession = sessionStatus.phase === 'starting';
  const loadingSession = sessionStatus.phase === 'loading';

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* Virtualized Message List */}
      <div ref={viewportRef} className="flex-1 min-h-0 overflow-y-auto">
        <VirtualizedMessageList
          messages={groupedMessages}
          running={running}
          startingSession={startingSession}
          loadingSession={loadingSession}
          scrollContainerRef={viewportRef}
          onScroll={onScroll}
          messagesEndRef={messagesEndRef}
          isNearBottom={isNearBottom}
          latestThinking={latestThinking}
          queuedMessageIds={queuedMessageIds}
          onRemoveQueuedMessage={removeQueuedMessage}
          isCompacting={isCompacting}
          getUuidForMessageId={getUuidForMessageId}
          onRewindToMessage={startRewindPreview}
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

      {/* Input Section with Prompts */}
      <div className="border-t">
        <PermissionPrompt
          permission={pendingRequest.type === 'permission' ? pendingRequest.request : null}
          onApprove={approvePermission}
        />
        <QuestionPrompt
          question={pendingRequest.type === 'question' ? pendingRequest.request : null}
          onAnswer={answerQuestion}
        />

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
          value={inputDraft}
          onChange={setInputDraft}
          attachments={inputAttachments}
          onAttachmentsChange={setInputAttachments}
          onHeightChange={handleHeightChange}
          pendingMessageCount={pendingMessages.size}
          slashCommands={slashCommands}
          tokenStats={tokenStats}
        />
      </div>

      {/* Rewind Confirmation Dialog */}
      <RewindConfirmationDialog
        rewindPreview={rewindPreview}
        onConfirm={confirmRewind}
        onCancel={cancelRewind}
      />
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
  const utils = trpc.useUtils();

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

  const { rightPanelVisible, activeTabId } = useWorkspacePanel();

  // Query workspace status to show initialization overlay
  const { data: workspaceInitStatus, isPending: isInitStatusPending } =
    trpc.workspace.getInitStatus.useQuery(
      { id: workspaceId },
      {
        // Poll while not ready
        refetchInterval: (query) => {
          const status = query.state.data?.status;
          return status === 'READY' || status === 'FAILED' || status === 'ARCHIVED' ? false : 1000;
        },
      }
    );

  // When init status becomes READY, refetch workspace to get updated worktreePath.
  // Also handles edge case where init is already READY on first load but workspace
  // data is stale (missing worktreePath).
  const prevInitStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const currentStatus = workspaceInitStatus?.status;
    const prevStatus = prevInitStatusRef.current;

    if (currentStatus === 'READY') {
      // Invalidate on status transition to READY, or if status was already READY
      // on first load but workspace is missing worktreePath (stale data)
      const isTransitionToReady = prevStatus !== undefined && prevStatus !== 'READY';
      const isStaleOnFirstLoad = prevStatus === undefined && !workspace?.worktreePath;

      if (isTransitionToReady || isStaleOnFirstLoad) {
        utils.workspace.get.invalidate({ id: workspaceId });
      }
    }

    prevInitStatusRef.current = currentStatus;
  }, [workspaceInitStatus?.status, workspaceId, utils, workspace?.worktreePath]);

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
    sessionStatus,
    pendingRequest,
    chatSettings,
    inputDraft,
    inputAttachments,
    queuedMessages,
    removeQueuedMessage,
    latestThinking,
    pendingMessages,
    isCompacting,
    slashCommands,
    tokenStats,
    rewindPreview,
    sendMessage,
    stopChat,
    approvePermission,
    answerQuestion,
    updateSettings,
    setInputDraft,
    setInputAttachments,
    startRewindPreview,
    confirmRewind,
    cancelRewind,
    getUuidForMessageId,
    inputRef,
    messagesEndRef,
  } = useChatWebSocket({
    workingDir: workspace?.worktreePath ?? undefined,
    dbSessionId: selectedDbSessionId,
  });

  // Derive boolean flags from sessionStatus for local use
  const running = sessionStatus.phase === 'running';
  const loadingSession = sessionStatus.phase === 'loading';
  // Session is ready when session_loaded has been received (ready or running phase)
  const isSessionReady = sessionStatus.phase === 'ready' || sessionStatus.phase === 'running';

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
    selectedModel: chatSettings.selectedModel,
    isSessionReady,
  });

  // Ref for scroll handling (virtualized list manages its own content)
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll behavior with RAF throttling
  const { onScroll, isNearBottom, scrollToBottom } = useAutoScroll(viewportRef);

  // Auto-focus chat input when entering workspace with active chat tab
  const hasFocusedOnEntryRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: inputRef is a stable ref object
  useEffect(() => {
    if (
      !(hasFocusedOnEntryRef.current || workspaceLoading) &&
      workspace &&
      selectedDbSessionId &&
      activeTabId === 'chat' &&
      !loadingSession
    ) {
      hasFocusedOnEntryRef.current = true;
      // Use setTimeout to ensure the input is mounted and ready
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [selectedDbSessionId, activeTabId, loadingSession, workspaceLoading, workspace]);

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
  // Show overlay for NEW, PROVISIONING, or FAILED states.
  // Include isPending to prevent flash of main UI while query is loading.
  const status = workspaceInitStatus?.status;
  const isInitializing =
    isInitStatusPending || status === 'NEW' || status === 'PROVISIONING' || status === 'FAILED';

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* Initialization Overlay - shown while workspace is being set up */}
      {isInitializing && (
        <InitializationOverlay
          workspaceId={workspaceId}
          status={workspaceInitStatus?.status ?? 'PROVISIONING'}
          initErrorMessage={workspaceInitStatus?.initErrorMessage ?? null}
          hasStartupScript={workspaceInitStatus?.hasStartupScript ?? false}
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
          {/* Run Script Port Badge */}
          <RunScriptPortBadge workspaceId={workspaceId} />
          {/* PR Link */}
          {workspace.prUrl && workspace.prNumber && workspace.prState !== 'NONE' && (
            <a
              href={workspace.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`flex items-center gap-1 text-xs hover:opacity-80 transition-opacity ${
                workspace.prState === 'MERGED'
                  ? 'text-green-500'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <GitPullRequest className="h-3 w-3" />#{workspace.prNumber}
              {workspace.prState === 'MERGED' && (
                <CheckCircle2 className="h-3 w-3 text-green-500" />
              )}
            </a>
          )}
          {/* CI Status Badge - shown for all open PRs */}
          {workspace.prUrl && workspace.prState === 'OPEN' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className={cn(
                    'flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium',
                    workspace.prCiStatus === 'SUCCESS' &&
                      'bg-green-100 dark:bg-green-950 text-green-700 dark:text-green-300',
                    workspace.prCiStatus === 'FAILURE' &&
                      'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-300',
                    workspace.prCiStatus === 'PENDING' &&
                      'bg-yellow-100 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-300',
                    workspace.prCiStatus === 'UNKNOWN' &&
                      'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'
                  )}
                >
                  {workspace.prCiStatus === 'SUCCESS' && (
                    <>
                      <CheckCircle2 className="h-3 w-3" />
                      <span>CI Passing</span>
                    </>
                  )}
                  {workspace.prCiStatus === 'FAILURE' && (
                    <>
                      <XCircle className="h-3 w-3" />
                      <span>CI Failing</span>
                    </>
                  )}
                  {workspace.prCiStatus === 'PENDING' && (
                    <>
                      <Circle className="h-3 w-3 animate-pulse" />
                      <span>CI Running</span>
                    </>
                  )}
                  {workspace.prCiStatus === 'UNKNOWN' && (
                    <>
                      <Circle className="h-3 w-3" />
                      <span>CI Unknown</span>
                    </>
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent>
                {workspace.prCiStatus === 'SUCCESS' && 'All CI checks are passing'}
                {workspace.prCiStatus === 'FAILURE' && 'Some CI checks are failing'}
                {workspace.prCiStatus === 'PENDING' && 'CI checks are currently running'}
                {workspace.prCiStatus === 'UNKNOWN' && 'CI status not yet determined'}
              </TooltipContent>
            </Tooltip>
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
          <RunScriptButton workspaceId={workspaceId} />
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
                variant={workspace.prState === 'MERGED' ? 'default' : 'ghost'}
                size="icon"
                className={cn(
                  'h-8 w-8',
                  workspace.prState === 'MERGED'
                    ? ''
                    : 'hover:bg-destructive/10 hover:text-destructive'
                )}
                onClick={() => {
                  // Skip confirmation if PR is already merged
                  if (workspace.prState === 'MERGED') {
                    archiveWorkspace.mutate({ id: workspaceId });
                  } else {
                    setArchiveDialogOpen(true);
                  }
                }}
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
              isCreatingSession={createSession.isPending}
              isDeletingSession={deleteSession.isPending}
              onWorkflowSelect={handleWorkflowSelect}
              onSelectSession={handleSelectSession}
              onCreateSession={handleNewChat}
              onCloseSession={handleCloseSession}
              maxSessions={maxSessions}
              hasWorktreePath={!!workspace?.worktreePath}
            >
              <ChatContent
                messages={messages}
                sessionStatus={sessionStatus}
                messagesEndRef={messagesEndRef}
                viewportRef={viewportRef}
                isNearBottom={isNearBottom}
                scrollToBottom={scrollToBottom}
                onScroll={onScroll}
                pendingRequest={pendingRequest}
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
                inputAttachments={inputAttachments}
                setInputAttachments={setInputAttachments}
                queuedMessages={queuedMessages}
                removeQueuedMessage={removeQueuedMessage}
                latestThinking={latestThinking}
                pendingMessages={pendingMessages}
                isCompacting={isCompacting}
                slashCommands={slashCommands}
                tokenStats={tokenStats}
                rewindPreview={rewindPreview}
                startRewindPreview={startRewindPreview}
                confirmRewind={confirmRewind}
                cancelRewind={cancelRewind}
                getUuidForMessageId={getUuidForMessageId}
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
