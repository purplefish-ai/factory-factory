import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { useChatWebSocket } from '@/components/chat';
import { usePersistentScroll, useWorkspacePanel } from '@/components/workspace';
import { trpc } from '@/frontend/lib/trpc';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import { forgetResumeWorkspace } from './resume-workspace-storage';
import { useSessionManagement, useWorkspaceData } from './use-workspace-detail';
import {
  useAutoFocusChatInput,
  useSelectedSessionId,
  useWorkspaceInitStatus,
} from './use-workspace-detail-hooks';
import type { ChatContentProps } from './workspace-detail-chat-content';
import { WorkspaceDetailView } from './workspace-detail-view';

export function WorkspaceDetailContainer() {
  const { slug = '', id: workspaceId = '' } = useParams<{ slug: string; id: string }>();
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  const { workspace, workspaceLoading, claudeSessions, initialDbSessionId, maxSessions } =
    useWorkspaceData({ workspaceId: workspaceId });

  const { rightPanelVisible, activeTabId, clearScrollState } = useWorkspacePanel();

  const { data: hasChanges } = trpc.workspace.hasChanges.useQuery(
    { workspaceId },
    { enabled: workspace?.hasHadSessions === true && workspace?.prState === 'NONE' }
  );

  const { workspaceInitStatus, isScriptFailed } = useWorkspaceInitStatus(
    workspaceId,
    workspace,
    utils
  );
  useEffect(() => {
    const phase = workspaceInitStatus?.phase;
    if (phase === 'READY' || phase === 'ARCHIVED') {
      forgetResumeWorkspace(workspaceId);
    }
  }, [workspaceId, workspaceInitStatus?.phase]);

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
    resumeQueuedMessages,
    latestThinking,
    pendingMessages,
    isCompacting,
    permissionMode,
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
    dbSessionId: selectedDbSessionId,
  });

  const loadingSession = sessionStatus.phase === 'loading';
  const isSessionReady = sessionStatus.phase === 'ready' || sessionStatus.phase === 'running';
  const isIssueAutoStartPending =
    workspace?.creationSource === 'GITHUB_ISSUE' &&
    selectedDbSessionId !== null &&
    (sessionStatus.phase === 'loading' || sessionStatus.phase === 'ready') &&
    processStatus.state === 'unknown' &&
    messages.some((message) => message.source === 'user') &&
    !messages.some((message) => message.source === 'claude');

  const sessionSummariesById = useMemo(
    () =>
      new Map((workspace?.sessionSummaries ?? []).map((summary) => [summary.sessionId, summary])),
    [workspace?.sessionSummaries]
  );
  const workspaceRunning = useMemo(
    () =>
      Array.from(sessionSummariesById.values()).some(
        (summary) => summary.activity === 'WORKING' || summary.runtimePhase === 'running'
      ),
    [sessionSummariesById]
  );

  const {
    createSession,
    deleteSession,
    archiveWorkspace,
    openInIde,
    availableIdes,
    preferredIde,
    handleSelectSession,
    handleCloseSession,
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
    // If PR is merged, skip confirmation and archive immediately.
    // Default commitUncommitted to true so we never lose work if git status hasn't loaded yet.
    if (workspace?.prState === 'MERGED') {
      handleArchive(true);
      return;
    }

    // Otherwise show confirmation dialog
    setArchiveDialogOpen(true);
  }, [workspace?.prState, handleArchive]);

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

  const chatViewModel: ChatContentProps = {
    workspaceId,
    messages,
    sessionStatus,
    messagesEndRef,
    viewportRef,
    isNearBottom,
    scrollToBottom,
    onScroll: handleChatScroll,
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
    resumeQueuedMessages,
    latestThinking,
    pendingMessages,
    isCompacting,
    permissionMode,
    slashCommands,
    slashCommandsLoaded,
    tokenStats,
    rewindPreview,
    startRewindPreview,
    confirmRewind,
    cancelRewind,
    getUuidForMessageId,
    autoStartPending: isIssueAutoStartPending,
    initBanner: workspaceInitStatus?.chatBanner ?? null,
  };

  return (
    <WorkspaceDetailView
      workspaceState={{
        workspaceLoading,
        workspace,
        workspaceId,
        handleBackToWorkspaces,
        isScriptFailed,
        workspaceInitStatus,
      }}
      header={{
        archivePending: archiveWorkspace.isPending,
        availableIdes,
        preferredIde,
        openInIde,
        handleArchiveRequest,
        handleQuickAction,
        running: workspaceRunning,
        isCreatingSession: createSession.isPending,
        hasChanges,
      }}
      sessionTabs={{
        claudeSessions,
        selectedDbSessionId,
        sessionSummariesById,
        isDeletingSession: deleteSession.isPending,
        handleSelectSession,
        handleNewChat,
        handleCloseChatSession,
        maxSessions,
        hasWorktreePath: !!workspace?.worktreePath,
      }}
      chat={chatViewModel}
      rightPanelVisible={rightPanelVisible}
      archiveDialog={{
        open: archiveDialogOpen,
        setOpen: setArchiveDialogOpen,
        hasUncommitted,
        onConfirm: handleArchive,
      }}
    />
  );
}
