import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { useChatWebSocket } from '@/components/chat';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import {
  ArchiveWorkspaceDialog,
  RightPanel,
  useWorkspacePanel,
  WorkspaceContentView,
} from '@/components/workspace';
import { Loading } from '@/frontend/components/loading';
import { trpc } from '@/frontend/lib/trpc';

import { useAutoScroll, useSessionManagement, useWorkspaceData } from './use-workspace-detail';
import {
  useAutoFocusChatInput,
  usePendingPrompt,
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

  const { rightPanelVisible, activeTabId } = useWorkspacePanel();

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

  const viewportRef = useRef<HTMLDivElement | null>(null);

  const { onScroll, isNearBottom, scrollToBottom } = useAutoScroll(viewportRef);

  useAutoFocusChatInput({
    workspaceLoading,
    workspace,
    selectedDbSessionId,
    activeTabId,
    loadingSession,
    inputRef,
  });

  // Handle pending prompts from workspace creation (stored in sessionStorage)
  usePendingPrompt({
    selectedDbSessionId,
    isSessionReady,
    sendMessage,
  });

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

  const runningSessionId = running && selectedDbSessionId ? selectedDbSessionId : undefined;

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

      {archiveWorkspace.isPending && <ArchivingOverlay />}

      <WorkspaceHeader
        workspace={workspace}
        workspaceId={workspaceId}
        availableIdes={availableIdes}
        preferredIde={preferredIde}
        openInIde={openInIde}
        archivePending={archiveWorkspace.isPending}
        onArchiveRequest={handleArchiveRequest}
        handleQuickAction={handleQuickAction}
        running={running}
        isCreatingSession={createSession.isPending}
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
                processStatus={processStatus}
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
        isPending={archiveWorkspace.isPending}
        onConfirm={handleArchive}
      />
    </div>
  );
}
