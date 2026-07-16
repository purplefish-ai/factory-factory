import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { trpc } from '@/client/lib/trpc';
import { isWorkspaceDoneOrMerged } from '@/client/lib/workspace-archive';
import { resolveWorkspaceFileLink } from '@/client/lib/workspace-file-links';
import { WorkspaceDetailHeaderSlot } from '@/client/routes/projects/workspaces/workspace-detail-header';
import { useChatWebSocket } from '@/components/chat';
import { usePersistentScroll, useWorkspacePanel } from '@/components/workspace';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import {
  resolveEffectiveSessionProvider,
  type SessionProviderValue,
} from '@/lib/session-provider-selection';
import { isSessionSummaryWorking } from '@/shared/session-runtime';
import { forgetResumeWorkspace } from './resume-workspace-storage';
import { useSessionManagement, useWorkspaceData } from './use-workspace-detail';
import {
  useAutoFocusChatInput,
  useSelectedSessionId,
  useWorkspaceInitStatus,
} from './use-workspace-detail-hooks';
import type { ChatContentProps } from './workspace-detail-chat-content';
import {
  buildSessionSummariesById,
  hasUserMessageWithoutAgentMessage,
} from './workspace-detail-container.utils';
import { WorkspaceDetailView } from './workspace-detail-view';

export function WorkspaceDetailContainer() {
  const { slug = '', id: workspaceId = '' } = useParams<{ slug: string; id: string }>();
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  const { workspace, workspaceLoading, sessions, initialDbSessionId, maxSessions } =
    useWorkspaceData({ workspaceId: workspaceId });

  useEffect(() => {
    if (workspace?.status !== 'ARCHIVING' && workspace?.status !== 'ARCHIVED') {
      return;
    }

    if (slug) {
      void navigate(`/projects/${slug}/workspaces`, { replace: true });
      return;
    }

    void navigate('/projects', { replace: true });
  }, [workspace?.status, slug, navigate]);

  const { rightPanelVisible, setRightPanelVisible, activeTabId, clearScrollState, openTab } =
    useWorkspacePanel();
  const { data: userSettings } = trpc.userSettings.get.useQuery();

  const { data: hasChanges } = trpc.workspace.hasChanges.useQuery(
    { workspaceId },
    { enabled: workspace?.hasHadSessions === true && workspace?.prState === 'NONE' }
  );

  const { workspaceInitStatus, isScriptFailed, setupWarningDismissed, dismissSetupWarning } =
    useWorkspaceInitStatus(workspaceId, workspace, utils);
  useEffect(() => {
    const phase = workspaceInitStatus?.phase;
    if (phase === 'READY' || phase === 'ARCHIVED') {
      forgetResumeWorkspace(workspaceId);
    }
  }, [workspaceId, workspaceInitStatus?.phase]);

  const sessionIds = useMemo(() => sessions?.map((s) => s.id) ?? [], [sessions]);
  const { selectedDbSessionId, setSelectedDbSessionId } = useSelectedSessionId(
    workspaceId,
    initialDbSessionId ?? null,
    sessionIds
  );
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const isParentWorkspace = workspace?.creationSource !== 'CHILD_WORKSPACE';
  const effectiveDefaultProvider = resolveEffectiveSessionProvider(
    workspace?.defaultSessionProvider,
    userSettings?.defaultSessionProvider
  );
  const [selectedProvider, setSelectedProvider] =
    useState<SessionProviderValue>(effectiveDefaultProvider);
  useEffect(() => {
    setSelectedProvider(effectiveDefaultProvider);
  }, [effectiveDefaultProvider]);

  const { data: gitStatus } = trpc.workspace.getGitStatus.useQuery(
    { workspaceId },
    { enabled: !!workspace?.worktreePath, refetchInterval: 15_000, staleTime: 10_000 }
  );
  const hasUncommitted = gitStatus?.hasUncommitted === true;
  const isDoneOrMergedWorkspace = isWorkspaceDoneOrMerged(workspace);
  const { data: childWorkspaces } = trpc.workspace.listChildren.useQuery(
    { parentWorkspaceId: workspaceId },
    { enabled: !isDoneOrMergedWorkspace && archiveDialogOpen && isParentWorkspace }
  );
  const activeChildCount = childWorkspaces?.length ?? 0;

  const {
    messages,
    connected,
    sessionStatus,
    processStatus,
    sessionRuntime,
    runtimeSessionId,
    pendingRequest,
    chatSettings,
    chatCapabilities,
    inputDraft,
    inputAttachments,
    queuedMessages,
    removeQueuedMessage,
    resumeQueuedMessages,
    latestThinking,
    pendingMessages,
    isCompacting,
    slashCommands,
    slashCommandsLoaded,
    tokenStats,
    rewindPreview,
    sendMessage,
    stopChat,
    restartSession,
    approvePermission,
    answerQuestion,
    updateSettings,
    setInputDraft,
    setInputAttachments,
    startRewindPreview,
    confirmRewind,
    cancelRewind,
    getUuidForMessageId,
    acpConfigOptions,
    setConfigOption,
    inputRef,
    messagesEndRef,
  } = useChatWebSocket({
    dbSessionId: selectedDbSessionId,
  });

  const loadingSession = sessionStatus.phase === 'loading';
  const isIssueAutoStartPending =
    workspace?.creationSource === 'GITHUB_ISSUE' &&
    selectedDbSessionId !== null &&
    (sessionStatus.phase === 'loading' || sessionStatus.phase === 'ready') &&
    processStatus.state === 'unknown' &&
    hasUserMessageWithoutAgentMessage(messages);

  const sessionSummariesById = useMemo(
    () =>
      buildSessionSummariesById({
        workspaceSummaries: workspace?.sessionSummaries,
        sessions,
        selectedSessionId: selectedDbSessionId,
        liveRuntime: sessionRuntime,
        runtimeSessionId,
        chatConnected: connected,
      }),
    [
      workspace?.sessionSummaries,
      sessions,
      selectedDbSessionId,
      sessionRuntime,
      runtimeSessionId,
      connected,
    ]
  );
  const workspaceRunning = useMemo(
    () =>
      Array.from(sessionSummariesById.values()).some((summary) => isSessionSummaryWorking(summary)),
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
    sessions,
    inputRef,
    selectedDbSessionId,
    setSelectedDbSessionId,
    selectedModel: chatSettings.selectedModel,
    selectedProvider,
  });

  const handleArchive = useCallback(
    (commitUncommitted: boolean) => {
      archiveWorkspace.mutate({ id: workspaceId, commitUncommitted });
    },
    [archiveWorkspace, workspaceId]
  );
  const handleArchiveRequest = useCallback(() => {
    // If workspace is done/merged, skip confirmation and archive immediately.
    // Default commitUncommitted to true so we never lose work if git status hasn't loaded yet.
    if (isDoneOrMergedWorkspace) {
      handleArchive(true);
      return;
    }

    // Otherwise show confirmation dialog
    setArchiveDialogOpen(true);
  }, [isDoneOrMergedWorkspace, handleArchive]);

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
  const initBanner =
    setupWarningDismissed && workspaceInitStatus?.chatBanner?.showDismiss
      ? null
      : (workspaceInitStatus?.chatBanner ?? null);

  const { persistCurrent: persistChatScroll } = usePersistentScroll({
    tabId: chatTabId,
    mode: 'chat',
    viewportRef,
    enabled: activeTabId === 'chat' && !!chatTabId,
    restoreDeps: [messages.length, activeTabId, chatTabId],
    autoStickToBottom: true,
    stickToBottomThreshold: 48,
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

  const resolveWorkspaceChatFileLink = useCallback(
    (href: string) => resolveWorkspaceFileLink(href, workspace?.worktreePath),
    [workspace?.worktreePath]
  );

  const handleWorkspaceFileLink = useCallback(
    (path: string) => {
      openTab('file', path, path.split('/').pop() ?? path);
    },
    [openTab]
  );

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
    resolveWorkspaceFileLink: resolveWorkspaceChatFileLink,
    onWorkspaceFileLink: handleWorkspaceFileLink,
    messages,
    sessionStatus,
    sessionRuntime,
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
    chatCapabilities,
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
    slashCommands,
    slashCommandsLoaded,
    tokenStats,
    rewindPreview,
    startRewindPreview,
    confirmRewind,
    cancelRewind,
    getUuidForMessageId,
    acpConfigOptions,
    setConfigOption,
    autoStartPending: isIssueAutoStartPending,
    initBanner,
  };

  return (
    <>
      {workspace && (
        <WorkspaceDetailHeaderSlot
          workspace={workspace}
          workspaceId={workspaceId}
          availableIdes={availableIdes}
          preferredIde={preferredIde}
          openInIde={openInIde}
          archivePending={archiveWorkspace.isPending}
          onArchiveRequest={handleArchiveRequest}
          handleQuickAction={handleQuickAction}
          running={workspaceRunning}
          isCreatingSession={createSession.isPending}
          hasChanges={hasChanges}
        />
      )}
      <WorkspaceDetailView
        workspaceState={{
          workspaceLoading,
          workspace,
          workspaceId,
          handleBackToWorkspaces,
          isScriptFailed,
          workspaceInitStatus,
          setupWarningDismissed,
          dismissSetupWarning,
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
          sessions,
          selectedDbSessionId,
          sessionSummariesById,
          isDeletingSession: deleteSession.isPending,
          handleSelectSession,
          handleNewChat,
          handleCloseChatSession,
          handleQuickAction,
          handleRestartSession: restartSession,
          maxSessions,
          hasWorktreePath: !!workspace?.worktreePath,
          selectedProvider,
          setSelectedProvider,
        }}
        chat={chatViewModel}
        rightPanelVisible={rightPanelVisible}
        setRightPanelVisible={setRightPanelVisible}
        archiveDialog={{
          open: archiveDialogOpen,
          setOpen: setArchiveDialogOpen,
          hasUncommitted: hasUncommitted && !isDoneOrMergedWorkspace,
          activeChildCount,
          onConfirm: handleArchive,
        }}
      />
    </>
  );
}
