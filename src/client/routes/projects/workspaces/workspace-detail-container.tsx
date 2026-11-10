import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  ChatSessionProvider,
  useChatSessionStore,
  useChatSessionSummary,
} from '@/client/features/chat';
import { getLiveSessionControlId } from '@/client/features/session-controls';
import {
  ArchiveGitLockDialog,
  useChatTranscriptPersistence,
  useWorkspacePanel,
} from '@/client/features/workspace';
import { getNewChatUnavailableReason } from '@/client/features/workspace/session-limit';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { isWorkspaceDoneOrMerged } from '@/client/lib/workspace-archive';
import { resolveWorkspaceFileLink } from '@/client/lib/workspace-file-links';
import { WorkspaceDetailHeaderSlot } from '@/client/routes/projects/workspaces/workspace-detail-header';
import { isSessionSummaryWorking } from '@/shared/session-runtime';
import { forgetResumeWorkspace } from './resume-workspace-storage';
import { useSessionManagement, useWorkspaceData } from './use-workspace-detail';
import {
  useArchivedWorkspaceRedirect,
  useAutoFocusChatInput,
  useSelectedSessionId,
  useWorkspaceHasChanges,
  useWorkspaceInitStatus,
} from './use-workspace-detail-hooks';
import { WorkspaceChat } from './workspace-chat-slot';
import {
  buildSessionSummariesById,
  getVisibleInitBanner,
  isProviderSubagentSessionReady,
} from './workspace-detail-container.utils';
import { WorkspaceDetailView } from './workspace-detail-view';

export function WorkspaceDetailContainer() {
  const { slug = '', id: workspaceId = '' } = useParams<{ slug: string; id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { key: navigationKey } = useLocation();
  const utils = trpc.useUtils();

  const {
    workspace,
    workspaceLoading,
    workspaceError,
    isFetchingWorkspace,
    refetchWorkspace,
    sessions,
    initialDbSessionId,
    maxSessions,
  } = useWorkspaceData({ workspaceId: workspaceId });
  // Only the error UI shows fetching.
  const isRetryingWorkspace = Boolean(workspaceError) && isFetchingWorkspace;

  const {
    rightPanelVisible,
    setRightPanelVisible,
    setActiveBottomTab,
    activeTabId,
    selectTab,
    tabs,
    openTab,
    openSubagentTab,
  } = useWorkspacePanel();

  const { workspaceInitStatus, isScriptFailed, setupWarningDismissed, dismissSetupWarning } =
    useWorkspaceInitStatus(workspaceId, workspace, utils);
  useEffect(() => {
    const phase = workspaceInitStatus?.phase;
    if (phase === 'READY' || phase === 'ARCHIVED') {
      forgetResumeWorkspace(workspaceId);
    }
  }, [workspaceId, workspaceInitStatus?.phase]);

  // Both feed the selection effect's dependencies.
  const sessionIds = useMemo(() => sessions?.map((s) => s.id) ?? [], [sessions]);
  const activateLinkedChat = useCallback(() => selectTab('chat'), [selectTab]);
  const { selectedDbSessionId, setSelectedDbSessionId: selectSession } = useSelectedSessionId(
    workspaceId,
    initialDbSessionId ?? null,
    sessionIds,
    searchParams.get('session'),
    activateLinkedChat,
    navigationKey
  );
  const setSelectedDbSessionId = (id: string | null) => {
    selectSession(id);
    if (searchParams.has('session')) {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.delete('session');
          return next;
        },
        { replace: true }
      );
    }
  };
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [archiveGitLockDialogOpen, setArchiveGitLockDialogOpen] = useState(false);
  const isParentWorkspace = workspace?.creationSource !== 'CHILD_WORKSPACE';

  const isDoneOrMergedWorkspace = isWorkspaceDoneOrMerged(workspace);
  const { data: childWorkspaces } = trpc.workspace.listChildren.useQuery(
    { parentWorkspaceId: workspaceId },
    { enabled: !isDoneOrMergedWorkspace && archiveDialogOpen && isParentWorkspace }
  );
  const activeChildCount = childWorkspaces?.length ?? 0;

  // The chat session lives in ChatSessionProvider below. This component reads
  // only its summary, so streamed events do not re-render it or the layout.
  const chatSession = useChatSessionStore();
  const chat = useChatSessionSummary(chatSession);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Summaries retain request metadata like snapshots do. Their consumers apply
  // canonical lifecycle precedence; the chat footer additionally requires a running prompt.
  const sessionSummariesById = buildSessionSummariesById({
    workspaceSummaries: workspace?.sessionSummaries,
    sessions,
    selectedSessionId: selectedDbSessionId,
    liveRuntime: chat.sessionRuntime,
    livePendingRequestType: chat.pendingRequestType,
    runtimeSessionId: chat.runtimeSessionId,
    chatConnected: chat.connected,
  });
  // The reducer keeps the previous session's queue during a switch until the new
  // session hydrates, so charge the queue to the session the chat state is
  // hydrated for; before hydration it belongs to no tab.
  const queuedMessageCount =
    chat.runtimeSessionId === null
      ? null
      : { sessionId: chat.runtimeSessionId, count: chat.queuedMessageCount };
  const workspaceRunning = Array.from(sessionSummariesById.values()).some(isSessionSummaryWorking);
  const selectedSessionControlId = getLiveSessionControlId(
    selectedDbSessionId,
    chat.connected && chat.controlsHydrated && chat.runtimeSessionId === selectedDbSessionId,
    chat.sessionRuntime
  );
  const hasChanges = useWorkspaceHasChanges(workspaceId, workspace, workspaceRunning, utils);

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
    onArchiveGitIndexLocked: () => setArchiveGitLockDialogOpen(true),
  });
  useArchivedWorkspaceRedirect({
    status: workspace?.status,
    slug,
    archivePending: archiveWorkspace.isPending,
  });

  const handleArchive = (removeGitIndexLock = false) => {
    archiveWorkspace.mutate(
      removeGitIndexLock ? { id: workspaceId, removeGitIndexLock: true } : { id: workspaceId }
    );
  };
  const handleArchiveRequest = () => {
    // If workspace is done/merged, skip confirmation and archive immediately.
    if (isDoneOrMergedWorkspace) {
      handleArchive();
      return;
    }

    // Otherwise show confirmation dialog
    setArchiveDialogOpen(true);
  };

  const persistence = useChatTranscriptPersistence({ workspaceId, sessionId: selectedDbSessionId });
  const activeMainTab = tabs.find((tab) => tab.id === activeTabId);
  const selectedSession = sessions?.find((session) => session.id === selectedDbSessionId);

  // The memoized chat content and transcript rows compare these by identity, so
  // a layout render does not re-render the transcript.
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
  const viewSetupOutput = useCallback(() => {
    setActiveBottomTab('setup-logs');
    setRightPanelVisible(true);
  }, [setActiveBottomTab, setRightPanelVisible]);
  const runQuickActionInNewChat = useCallback(
    (name: string, prompt: string) => {
      runInBackground(handleQuickAction(name, prompt), "Couldn't run quick action.");
    },
    [handleQuickAction]
  );

  useAutoFocusChatInput({
    workspaceLoading,
    workspace,
    selectedDbSessionId,
    activeTabId,
    loadingSession: chat.loadingSession,
    inputRef,
  });

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
      <ChatSessionProvider store={chatSession} dbSessionId={selectedDbSessionId}>
        <WorkspaceDetailView
          workspaceState={{
            workspace,
            workspaceError,
            isFetchingWorkspace: isRetryingWorkspace,
            refetchWorkspace,
            workspaceId,
            handleBackToWorkspaces: () => {
              runInBackground(
                Promise.resolve(navigate(`/projects/${slug}/workspaces`)),
                "Couldn't open workspace list."
              );
            },
            isScriptFailed,
            workspaceInitStatus,
            setupWarningDismissed,
            dismissSetupWarning,
          }}
          header={{
            archivePending: archiveWorkspace.isPending,
            handleQuickAction,
            isCreatingSession: createSession.isPending,
          }}
          sessionTabs={{
            sessions,
            selectedDbSessionId,
            selectedSessionReady: isProviderSubagentSessionReady(selectedDbSessionId),
            selectedSessionControlId,
            selectedSessionControlRuntimeId: chat.sessionRuntime.work?.controlRuntimeId,
            sessionSummariesById,
            queuedMessageCount,
            isDeletingSession: deleteSession.isPending,
            handleSelectSession,
            handleNewChat,
            handleCloseChatSession: (sessionId: string) => {
              persistence.clearSession(sessionId);
              handleCloseSession(sessionId);
            },
            handleRestartSession: chatSession.restartSession,
            isRestartingSession: chat.isRestartingSession,
            handleOpenSubagentTab: openSubagentTab,
            maxSessions,
            hasWorktreePath: Boolean(workspace?.worktreePath),
          }}
          chat={
            <WorkspaceChat
              workspaceId={workspaceId}
              sessionId={selectedDbSessionId}
              codexAccountId={selectedSession?.codexAccountId}
              parentSessionName={selectedSession?.name}
              issueAutoStart={workspace?.creationSource === 'GITHUB_ISSUE'}
              active={!activeMainTab || activeMainTab.type === 'chat'}
              position={persistence}
              inputRef={inputRef}
              onViewSetupOutput={viewSetupOutput}
              retryAvailability={workspaceInitStatus?.retryAvailability}
              resolveWorkspaceFileLink={resolveWorkspaceChatFileLink}
              onWorkspaceFileLink={handleWorkspaceFileLink}
              onOpenSubagent={openSubagentTab}
              initBanner={getVisibleInitBanner(
                workspaceInitStatus?.chatBanner,
                setupWarningDismissed
              )}
              isScriptFailed={isScriptFailed}
              onRunQuickActionInNewChat={runQuickActionInNewChat}
              newChatUnavailableReason={getNewChatUnavailableReason({
                sessions,
                maxSessions,
                isCreatingSession: createSession.isPending,
                isDeletingSession: deleteSession.isPending,
                hasWorktreePath: Boolean(workspace?.worktreePath),
              })}
            />
          }
          resumeQueuedMessages={chatSession.resumeQueuedMessages}
          rightPanelVisible={rightPanelVisible}
          setRightPanelVisible={setRightPanelVisible}
          archiveDialog={{
            open: archiveDialogOpen,
            setOpen: setArchiveDialogOpen,
            activeChildCount,
            onConfirm: () => handleArchive(),
          }}
        />
      </ChatSessionProvider>
      <ArchiveGitLockDialog
        open={archiveGitLockDialogOpen}
        onOpenChange={setArchiveGitLockDialogOpen}
        onRetry={() => handleArchive()}
        onRemoveLockAndArchive={() => handleArchive(true)}
        isPending={archiveWorkspace.isPending}
      />
    </>
  );
}
