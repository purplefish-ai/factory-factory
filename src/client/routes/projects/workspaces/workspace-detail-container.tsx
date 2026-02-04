import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { useChatWebSocket } from '@/components/chat';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import {
  ArchiveWorkspaceDialog,
  RightPanel,
  usePersistentScroll,
  useWorkspacePanel,
  WorkspaceContentView,
} from '@/components/workspace';
import { Loading } from '@/frontend/components/loading';
import { trpc } from '@/frontend/lib/trpc';

import { useAutoScroll, useSessionManagement, useWorkspaceData } from './use-workspace-detail';
import {
  useAutoFocusChatInput,
  useSelectedSessionId,
  useWorkspaceInitStatus,
} from './use-workspace-detail-hooks';
import { ChatContent } from './workspace-detail-chat-content';
import { WorkspaceHeader } from './workspace-detail-header';
import { ArchivingOverlay, InitializationOverlay } from './workspace-overlays';

export function WorkspaceDetailContainer() {
  const { slug = '', id: workspaceId = '' } = useParams<{ slug: string; id: string }>();
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  // Mark workspace as seen when user navigates into it (clears needsAttention flag)
  const markAsSeen = trpc.workspace.markAsSeen.useMutation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only run once when workspaceId changes
  useEffect(() => {
    if (workspaceId) {
      markAsSeen.mutate({ workspaceId });
    }
  }, [workspaceId]);

  const {
    workspace,
    workspaceLoading,
    claudeSessions,
    workflows,
    recommendedWorkflow,
    initialDbSessionId,
    maxSessions,
    invalidateWorkspace,
  } = useWorkspaceData({ workspaceId: workspaceId });

  const { rightPanelVisible, activeTabId, clearScrollState } = useWorkspacePanel();

  const { data: hasChanges } = trpc.workspace.hasChanges.useQuery(
    { workspaceId },
    { enabled: workspace?.hasHadSessions === true && workspace?.prState === 'NONE' }
  );

  const { workspaceInitStatus, isInitializing } = useWorkspaceInitStatus(
    workspaceId,
    workspace,
    utils
  );

  const { selectedDbSessionId, setSelectedDbSessionId } = useSelectedSessionId(
    initialDbSessionId ?? null
  );
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);

  const { data: gitStatus } = trpc.workspace.getGitStatus.useQuery(
    { workspaceId },
    { enabled: !!workspace?.worktreePath, refetchInterval: 15_000, staleTime: 10_000 }
  );
  const hasUncommitted = gitStatus?.hasUncommitted === true;

  const {
    messages,
    connected,
    sessionStatus,
    processStatus,
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
    slashCommandsLoaded,
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

  const running = sessionStatus.phase === 'running';
  const loadingSession = sessionStatus.phase === 'loading';
  const isSessionReady = sessionStatus.phase === 'ready' || sessionStatus.phase === 'running';

  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (wasRunningRef.current && !running) {
      invalidateWorkspace();
    }
    wasRunningRef.current = running;
  }, [running, invalidateWorkspace]);

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

  const handleArchiveError = useCallback((error: unknown) => {
    const typedError = error as { data?: { code?: string }; message?: string };
    if (typedError.data?.code === 'PRECONDITION_FAILED') {
      toast.error('Archiving blocked: enable commit before archiving to proceed.');
      return;
    }
    toast.error(typedError.message ?? 'Failed to archive workspace');
  }, []);

  const handleArchive = useCallback(
    (commitUncommitted: boolean) => {
      archiveWorkspace.mutate(
        { id: workspaceId, commitUncommitted },
        {
          onError: handleArchiveError,
        }
      );
    },
    [archiveWorkspace, handleArchiveError, workspaceId]
  );

  const handleArchiveRequest = useCallback(() => {
    setArchiveDialogOpen(true);
  }, []);

  const handleBackToWorkspaces = useCallback(
    () => navigate(`/projects/${slug}/workspaces`),
    [navigate, slug]
  );

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const prevSessionIdRef = useRef<string | null>(null);

  const { onScroll, isNearBottom, scrollToBottom } = useAutoScroll(viewportRef);

  const handleCloseChatSession = useCallback(
    (sessionId: string) => {
      clearScrollState(`chat-${sessionId}`);
      handleCloseSession(sessionId);
    },
    [clearScrollState, handleCloseSession]
  );

  const chatTabId = selectedDbSessionId ? `chat-${selectedDbSessionId}` : null;

  const { persistCurrent: persistChatScroll } = usePersistentScroll({
    tabId: chatTabId,
    mode: 'chat',
    viewportRef,
    enabled: activeTabId === 'chat' && !!chatTabId,
    restoreDeps: [messages.length, activeTabId, chatTabId],
    autoStickToBottom: true,
    stickToBottomThreshold: 150,
    onRestore: onScroll,
  });

  useEffect(() => {
    const prev = prevSessionIdRef.current;
    if (prev && prev !== selectedDbSessionId) {
      persistChatScroll(`chat-${prev}`);
    }
    prevSessionIdRef.current = selectedDbSessionId;
  }, [selectedDbSessionId, persistChatScroll]);

  const handleChatScroll = useCallback(() => {
    onScroll();
    persistChatScroll();
  }, [onScroll, persistChatScroll]);

  useAutoFocusChatInput({
    workspaceLoading,
    workspace,
    selectedDbSessionId,
    activeTabId,
    loadingSession,
    inputRef,
  });

  const runningSessionId = getRunningSessionId(running, selectedDbSessionId);

  return renderWorkspaceBody({
    workspaceLoading,
    workspace,
    workspaceId,
    handleBackToWorkspaces,
    isInitializing,
    workspaceInitStatus,
    archivePending: archiveWorkspace.isPending,
    availableIdes,
    preferredIde,
    openInIde,
    handleArchiveRequest,
    handleQuickAction,
    running,
    isCreatingSession: createSession.isPending,
    hasChanges,
    claudeSessions,
    workflows,
    recommendedWorkflow,
    selectedDbSessionId,
    runningSessionId,
    isDeletingSession: deleteSession.isPending,
    handleWorkflowSelect,
    handleSelectSession,
    handleNewChat,
    handleCloseChatSession,
    maxSessions,
    hasWorktreePath: !!workspace?.worktreePath,
    messages,
    sessionStatus,
    processStatus,
    messagesEndRef,
    viewportRef,
    isNearBottom,
    scrollToBottom,
    handleChatScroll,
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
    slashCommandsLoaded,
    tokenStats,
    rewindPreview,
    startRewindPreview,
    confirmRewind,
    cancelRewind,
    getUuidForMessageId,
    rightPanelVisible,
    archiveDialogOpen,
    setArchiveDialogOpen,
    hasUncommitted,
    handleArchive,
  });
}

function getRunningSessionId(running: boolean, selectedDbSessionId: string | null) {
  if (!(running && selectedDbSessionId)) {
    return undefined;
  }
  return selectedDbSessionId;
}

interface RenderWorkspaceBodyProps {
  workspaceLoading: boolean;
  workspace: ReturnType<typeof useWorkspaceData>['workspace'];
  workspaceId: string;
  handleBackToWorkspaces: () => void;
  isInitializing: boolean;
  workspaceInitStatus: ReturnType<typeof useWorkspaceInitStatus>['workspaceInitStatus'];
  archivePending: boolean;
  availableIdes: ReturnType<typeof useSessionManagement>['availableIdes'];
  preferredIde: string;
  openInIde: ReturnType<typeof useSessionManagement>['openInIde'];
  handleArchiveRequest: () => void;
  handleQuickAction: ReturnType<typeof useSessionManagement>['handleQuickAction'];
  running: boolean;
  isCreatingSession: boolean;
  hasChanges: boolean | undefined;
  claudeSessions: ReturnType<typeof useWorkspaceData>['claudeSessions'];
  workflows: ReturnType<typeof useWorkspaceData>['workflows'];
  recommendedWorkflow: ReturnType<typeof useWorkspaceData>['recommendedWorkflow'];
  selectedDbSessionId: string | null;
  runningSessionId: string | undefined;
  isDeletingSession: boolean;
  handleWorkflowSelect: ReturnType<typeof useSessionManagement>['handleWorkflowSelect'];
  handleSelectSession: ReturnType<typeof useSessionManagement>['handleSelectSession'];
  handleNewChat: ReturnType<typeof useSessionManagement>['handleNewChat'];
  handleCloseChatSession: ReturnType<typeof useSessionManagement>['handleCloseSession'];
  maxSessions: ReturnType<typeof useWorkspaceData>['maxSessions'];
  hasWorktreePath: boolean;
  messages: ReturnType<typeof useChatWebSocket>['messages'];
  sessionStatus: ReturnType<typeof useChatWebSocket>['sessionStatus'];
  processStatus: ReturnType<typeof useChatWebSocket>['processStatus'];
  messagesEndRef: ReturnType<typeof useChatWebSocket>['messagesEndRef'];
  viewportRef: RefObject<HTMLDivElement | null>;
  isNearBottom: boolean;
  scrollToBottom: () => void;
  handleChatScroll: () => void;
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
  slashCommands: ReturnType<typeof useChatWebSocket>['slashCommands'];
  slashCommandsLoaded: ReturnType<typeof useChatWebSocket>['slashCommandsLoaded'];
  tokenStats: ReturnType<typeof useChatWebSocket>['tokenStats'];
  rewindPreview: ReturnType<typeof useChatWebSocket>['rewindPreview'];
  startRewindPreview: ReturnType<typeof useChatWebSocket>['startRewindPreview'];
  confirmRewind: ReturnType<typeof useChatWebSocket>['confirmRewind'];
  cancelRewind: ReturnType<typeof useChatWebSocket>['cancelRewind'];
  getUuidForMessageId: ReturnType<typeof useChatWebSocket>['getUuidForMessageId'];
  rightPanelVisible: boolean;
  archiveDialogOpen: boolean;
  setArchiveDialogOpen: Dispatch<SetStateAction<boolean>>;
  hasUncommitted: boolean;
  handleArchive: (commitUncommitted: boolean) => void;
}

function renderWorkspaceBody({
  workspaceLoading,
  workspace,
  workspaceId,
  handleBackToWorkspaces,
  isInitializing,
  workspaceInitStatus,
  archivePending,
  availableIdes,
  preferredIde,
  openInIde,
  handleArchiveRequest,
  handleQuickAction,
  running,
  isCreatingSession,
  hasChanges,
  claudeSessions,
  workflows,
  recommendedWorkflow,
  selectedDbSessionId,
  runningSessionId,
  isDeletingSession,
  handleWorkflowSelect,
  handleSelectSession,
  handleNewChat,
  handleCloseChatSession,
  maxSessions,
  hasWorktreePath,
  messages,
  sessionStatus,
  processStatus,
  messagesEndRef,
  viewportRef,
  isNearBottom,
  scrollToBottom,
  handleChatScroll,
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
  slashCommandsLoaded,
  tokenStats,
  rewindPreview,
  startRewindPreview,
  confirmRewind,
  cancelRewind,
  getUuidForMessageId,
  rightPanelVisible,
  archiveDialogOpen,
  setArchiveDialogOpen,
  hasUncommitted,
  handleArchive,
}: RenderWorkspaceBodyProps) {
  if (workspaceLoading) {
    return <Loading message="Loading workspace..." />;
  }

  if (!workspace) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-destructive">Workspace not found</p>
        <Button variant="outline" onClick={handleBackToWorkspaces}>
          Back to workspaces
        </Button>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {isInitializing && (
        <InitializationOverlay
          workspaceId={workspaceId}
          status={workspaceInitStatus?.status ?? 'PROVISIONING'}
          initErrorMessage={workspaceInitStatus?.initErrorMessage ?? null}
          initOutput={workspaceInitStatus?.initOutput ?? null}
          hasStartupScript={workspaceInitStatus?.hasStartupScript ?? false}
        />
      )}

      {archivePending && <ArchivingOverlay />}

      <WorkspaceHeader
        workspace={workspace}
        workspaceId={workspaceId}
        availableIdes={availableIdes}
        preferredIde={preferredIde}
        openInIde={openInIde}
        archivePending={archivePending}
        onArchiveRequest={handleArchiveRequest}
        handleQuickAction={handleQuickAction}
        running={running}
        isCreatingSession={isCreatingSession}
        hasChanges={hasChanges}
      />

      <ResizablePanelGroup
        direction="horizontal"
        className="flex-1 overflow-hidden"
        autoSaveId="workspace-main-panel"
      >
        {/* NOTE: react-resizable-panels v4+ changed its API to use percentage strings. */}
        <ResizablePanel defaultSize="70%" minSize="30%">
          <div className="h-full flex flex-col min-w-0">
            <WorkspaceContentView
              workspaceId={workspaceId}
              claudeSessions={claudeSessions}
              workflows={workflows}
              recommendedWorkflow={recommendedWorkflow}
              selectedSessionId={selectedDbSessionId}
              runningSessionId={runningSessionId}
              sessionStatus={sessionStatus}
              processStatus={processStatus}
              isCreatingSession={isCreatingSession}
              isDeletingSession={isDeletingSession}
              onWorkflowSelect={handleWorkflowSelect}
              onSelectSession={handleSelectSession}
              onCreateSession={handleNewChat}
              onCloseSession={handleCloseChatSession}
              maxSessions={maxSessions}
              hasWorktreePath={hasWorktreePath}
            >
              <ChatContent
                messages={messages}
                sessionStatus={sessionStatus}
                messagesEndRef={messagesEndRef}
                viewportRef={viewportRef}
                isNearBottom={isNearBottom}
                scrollToBottom={scrollToBottom}
                onScroll={handleChatScroll}
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
                slashCommandsLoaded={slashCommandsLoaded}
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

      <ArchiveWorkspaceDialog
        open={archiveDialogOpen}
        onOpenChange={setArchiveDialogOpen}
        hasUncommitted={hasUncommitted}
        isPending={archivePending}
        onConfirm={handleArchive}
      />
    </div>
  );
}
