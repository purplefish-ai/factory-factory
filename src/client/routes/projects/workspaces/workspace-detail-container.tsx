import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { useChatWebSocket } from '@/components/chat';
import { usePersistentScroll, useWorkspacePanel } from '@/components/workspace';
import type { WorkspaceSessionRuntimeSummary } from '@/components/workspace/session-tab-runtime';
import { trpc } from '@/frontend/lib/trpc';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import {
  resolveEffectiveSessionProvider,
  type SessionProviderValue,
} from '@/lib/session-provider-selection';
import type { SessionRuntimeState } from '@/shared/session-runtime';
import { forgetResumeWorkspace } from './resume-workspace-storage';
import { useSessionManagement, useWorkspaceData } from './use-workspace-detail';
import {
  useAutoFocusChatInput,
  useSelectedSessionId,
  useWorkspaceInitStatus,
} from './use-workspace-detail-hooks';
import type { ChatContentProps } from './workspace-detail-chat-content';
import { WorkspaceDetailView } from './workspace-detail-view';

function areRuntimeStatesEqual(
  left: SessionRuntimeState | undefined,
  right: SessionRuntimeState
): boolean {
  if (!left) {
    return false;
  }

  const leftExit = left.lastExit;
  const rightExit = right.lastExit;
  const sameLastExit =
    leftExit === rightExit ||
    (leftExit?.code === rightExit?.code &&
      leftExit?.timestamp === rightExit?.timestamp &&
      leftExit?.unexpected === rightExit?.unexpected);

  return (
    left.phase === right.phase &&
    left.processState === right.processState &&
    left.activity === right.activity &&
    left.updatedAt === right.updatedAt &&
    sameLastExit
  );
}

function isLiveRuntimeNewerOrEqual(
  liveRuntime: SessionRuntimeState,
  summaryUpdatedAt: string | undefined
): boolean {
  if (!summaryUpdatedAt) {
    return true;
  }
  const liveTs = Date.parse(liveRuntime.updatedAt);
  const summaryTs = Date.parse(summaryUpdatedAt);
  if (Number.isNaN(liveTs) || Number.isNaN(summaryTs)) {
    return true;
  }
  return liveTs >= summaryTs;
}

interface SessionForRuntimeOverlay {
  id: string;
  name: string | null;
  workflow: string | null;
  model: string | null;
  provider?: WorkspaceSessionRuntimeSummary['provider'];
  status: WorkspaceSessionRuntimeSummary['persistedStatus'];
}

function mergeSessionSummariesWithLiveRuntime(
  workspaceSummaries: WorkspaceSessionRuntimeSummary[] | undefined,
  sessions: SessionForRuntimeOverlay[] | undefined,
  liveSessionRuntimeById: Map<string, SessionRuntimeState>
): Map<string, WorkspaceSessionRuntimeSummary> {
  const summaries = new Map(
    (workspaceSummaries ?? []).map((summary) => [summary.sessionId, summary])
  );

  for (const session of sessions ?? []) {
    const liveRuntime = liveSessionRuntimeById.get(session.id);
    if (!liveRuntime) {
      continue;
    }

    const existingSummary = summaries.get(session.id);
    if (!isLiveRuntimeNewerOrEqual(liveRuntime, existingSummary?.updatedAt)) {
      continue;
    }

    summaries.set(session.id, {
      sessionId: session.id,
      name: existingSummary?.name ?? session.name ?? null,
      workflow: existingSummary?.workflow ?? session.workflow ?? null,
      model: existingSummary?.model ?? session.model ?? null,
      provider: existingSummary?.provider ?? session.provider,
      persistedStatus: existingSummary?.persistedStatus ?? session.status,
      runtimePhase: liveRuntime.phase,
      processState: liveRuntime.processState,
      activity: liveRuntime.activity,
      updatedAt: liveRuntime.updatedAt,
      lastExit: liveRuntime.lastExit ?? existingSummary?.lastExit ?? null,
    });
  }

  return summaries;
}

export function WorkspaceDetailContainer() {
  const { slug = '', id: workspaceId = '' } = useParams<{ slug: string; id: string }>();
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  const { workspace, workspaceLoading, sessions, initialDbSessionId, maxSessions } =
    useWorkspaceData({ workspaceId: workspaceId });

  useEffect(() => {
    if (workspace?.status !== 'ARCHIVED') {
      return;
    }

    if (slug) {
      void navigate(`/projects/${slug}`, { replace: true });
      return;
    }

    void navigate('/projects', { replace: true });
  }, [workspace?.status, slug, navigate]);

  const { rightPanelVisible, setRightPanelVisible, activeTabId, clearScrollState } =
    useWorkspacePanel();
  const { data: userSettings } = trpc.userSettings.get.useQuery();

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

  const sessionIds = useMemo(() => sessions?.map((s) => s.id) ?? [], [sessions]);
  const { selectedDbSessionId, setSelectedDbSessionId } = useSelectedSessionId(
    workspaceId,
    initialDbSessionId ?? null,
    sessionIds
  );
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
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

  const {
    messages,
    connected,
    sessionStatus,
    processStatus,
    sessionRuntime,
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
    messages.some((message) => message.source === 'user') &&
    !messages.some((message) => message.source === 'agent');

  const [liveSessionRuntimeById, setLiveSessionRuntimeById] = useState<
    Map<string, SessionRuntimeState>
  >(new Map());

  useEffect(() => {
    if (!selectedDbSessionId) {
      return;
    }

    setLiveSessionRuntimeById((previous) => {
      const previousRuntime = previous.get(selectedDbSessionId);
      if (areRuntimeStatesEqual(previousRuntime, sessionRuntime)) {
        return previous;
      }

      const next = new Map(previous);
      next.set(selectedDbSessionId, sessionRuntime);
      return next;
    });
  }, [selectedDbSessionId, sessionRuntime]);

  useEffect(() => {
    const knownSessionIds = new Set(sessionIds);
    setLiveSessionRuntimeById((previous) => {
      let changed = false;
      const next = new Map<string, SessionRuntimeState>();
      for (const [sessionId, runtime] of previous) {
        if (knownSessionIds.has(sessionId)) {
          next.set(sessionId, runtime);
        } else {
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [sessionIds]);

  const sessionSummariesById = useMemo(
    () =>
      mergeSessionSummariesWithLiveRuntime(
        workspace?.sessionSummaries,
        sessions,
        liveSessionRuntimeById
      ),
    [workspace?.sessionSummaries, sessions, liveSessionRuntimeById]
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
    sessions,
    inputRef,
    selectedDbSessionId,
    setSelectedDbSessionId,
    selectedModel: chatSettings.selectedModel,
    selectedProvider,
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
        sessions,
        selectedDbSessionId,
        sessionSummariesById,
        isDeletingSession: deleteSession.isPending,
        handleSelectSession,
        handleNewChat,
        handleCloseChatSession,
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
        hasUncommitted,
        onConfirm: handleArchive,
      }}
    />
  );
}
