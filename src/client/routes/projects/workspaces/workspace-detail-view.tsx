import { type Dispatch, memo, type SetStateAction, useCallback, useState } from 'react';
import { Loading } from '@/client/components/loading';
import { WorkspaceToolsDrawer } from '@/client/components/workspace-tools-drawer';
import type { SubagentSelection } from '@/client/features/subagents';
import { ArchiveWorkspaceDialog } from '@/client/features/workspace';
import { RightPanel } from '@/client/features/workspace/right-panel';
import type { SessionQueuedMessageCount } from '@/client/features/workspace/session-close-guard';
import type { WorkspaceSessionRuntimeSummary } from '@/client/features/workspace/session-tab-runtime';
import { WorkspaceContentView } from '@/client/features/workspace/workspace-content-view';
import { useWorkspaceDrawer } from '@/client/hooks/use-workspace-drawer';
import { Button } from '@/components/ui/button';
import { ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { SessionlessSetupFailure } from './sessionless-setup-failure';
import type { useSessionManagement, useWorkspaceData } from './use-workspace-detail';
import type { useWorkspaceInitStatus } from './use-workspace-detail-hooks';
import { CONNECTED_CHAT_CONTENT } from './workspace-chat-slot';
import type { ChatContentProps } from './workspace-detail-chat-content';
import { getVisibleInitBanner } from './workspace-detail-container.utils';
import { ArchivingOverlay, ScriptFailedBanner } from './workspace-overlays';
import { WorkspaceSidePanel } from './workspace-side-panel';

const TAKE_SCREENSHOTS_PROMPT =
  'Take a screenshot of the workspace dev app using Playwright MCP tools. Read factory-factory.json for the scripts.run command, pick a free port, replace {port}, and start the dev server in the background. Once ready, determine the most relevant screen and save a screenshot to .factory-factory/screenshots/ with a descriptive filename.';

interface WorkspaceStateProps {
  workspaceLoading: boolean;
  workspace: ReturnType<typeof useWorkspaceData>['workspace'];
  workspaceId: string;
  handleBackToWorkspaces: () => void;
  isScriptFailed: boolean;
  workspaceInitStatus: ReturnType<typeof useWorkspaceInitStatus>['workspaceInitStatus'];
  setupWarningDismissed: boolean | null;
  dismissSetupWarning: () => void;
}

interface HeaderProps {
  archivePending: boolean;
  handleQuickAction: ReturnType<typeof useSessionManagement>['handleQuickAction'];
  isCreatingSession: boolean;
}

interface SessionTabsProps {
  sessions: ReturnType<typeof useWorkspaceData>['sessions'];
  selectedDbSessionId: string | null;
  selectedSessionReady: boolean;
  selectedSessionControlId?: string;
  selectedSessionControlRuntimeId?: string;
  sessionSummariesById: ReadonlyMap<string, WorkspaceSessionRuntimeSummary>;
  /** Unsent queued messages and their session; closing that tab discards them. */
  queuedMessageCount?: SessionQueuedMessageCount | null;
  isDeletingSession: boolean;
  handleSelectSession: ReturnType<typeof useSessionManagement>['handleSelectSession'];
  handleNewChat: ReturnType<typeof useSessionManagement>['handleNewChat'];
  handleCloseChatSession: ReturnType<typeof useSessionManagement>['handleCloseSession'];
  handleRestartSession: () => void;
  handleOpenSubagentTab: (selection: SubagentSelection) => void;
  maxSessions: ReturnType<typeof useWorkspaceData>['maxSessions'];
  hasWorktreePath: boolean;
}

interface ArchiveDialogProps {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  activeChildCount: number;
  onConfirm: () => void;
}

export interface WorkspaceDetailViewProps {
  workspaceState: WorkspaceStateProps;
  header: HeaderProps;
  sessionTabs: SessionTabsProps;
  /** Chat content itself is provided through ChatContentPropsProvider. */
  resumeQueuedMessages: ChatContentProps['resumeQueuedMessages'];
  rightPanelVisible: boolean;
  setRightPanelVisible: (visible: boolean) => void;
  archiveDialog: ArchiveDialogProps;
}

function ScriptBanner({
  workspaceId,
  isScriptFailed,
  workspaceInitStatus,
  setupWarningDismissed,
  dismissSetupWarning,
  resumeQueuedMessages,
}: {
  workspaceId: string;
  isScriptFailed: boolean;
  workspaceInitStatus: WorkspaceStateProps['workspaceInitStatus'];
  setupWarningDismissed: boolean | null;
  dismissSetupWarning: () => void;
  resumeQueuedMessages: ChatContentProps['resumeQueuedMessages'];
}) {
  const visibleBanner = getVisibleInitBanner(
    workspaceInitStatus?.chatBanner,
    setupWarningDismissed
  );
  if (isScriptFailed && visibleBanner) {
    return (
      <ScriptFailedBanner
        retryAvailability={workspaceInitStatus?.retryAvailability}
        workspaceId={workspaceId}
        initErrorMessage={workspaceInitStatus?.initErrorMessage ?? null}
        initOutput={workspaceInitStatus?.initOutput ?? null}
        hasStartupScript={workspaceInitStatus?.hasStartupScript ?? false}
        showPlay={visibleBanner.showPlay}
        onPlay={resumeQueuedMessages}
        showDismiss={visibleBanner.showDismiss}
        onDismiss={dismissSetupWarning}
      />
    );
  }
  return null;
}

/**
 * Memoized so streamed chat events, which re-render the container on every token,
 * skip the layout here. The container passes memoized prop groups.
 */
export const WorkspaceDetailView = memo(function WorkspaceDetailView({
  workspaceState,
  header,
  sessionTabs,
  resumeQueuedMessages,
  rightPanelVisible,
  setRightPanelVisible,
  archiveDialog,
}: WorkspaceDetailViewProps) {
  const isMobile = useWorkspaceDrawer();
  const [isTakingScreenshots, setIsTakingScreenshots] = useState(false);
  const selectedSessionIndex =
    sessionTabs.sessions?.findIndex((session) => session.id === sessionTabs.selectedDbSessionId) ??
    -1;
  const selectedSession =
    selectedSessionIndex >= 0 ? sessionTabs.sessions?.[selectedSessionIndex] : undefined;
  const selectedSessionName = selectedSession
    ? selectedSession.name?.trim() || `Session ${selectedSessionIndex + 1}`
    : null;

  const handleTakeScreenshots = useCallback(async () => {
    setIsTakingScreenshots(true);
    try {
      await header.handleQuickAction('Take Screenshots', TAKE_SCREENSHOTS_PROMPT);
    } catch {
      // The session mutation reports the error to the user.
    } finally {
      setIsTakingScreenshots(false);
    }
  }, [header.handleQuickAction]);

  const handleOpenSubagent = useCallback(
    (selection: SubagentSelection) => {
      if (
        !(selectedSessionName && sessionTabs.selectedDbSessionId) ||
        selection.parentSessionId !== sessionTabs.selectedDbSessionId
      ) {
        return;
      }
      sessionTabs.handleOpenSubagentTab({
        ...selection,
        parentSessionName: selectedSessionName,
      });
      if (isMobile) {
        setRightPanelVisible(false);
      }
    },
    [
      isMobile,
      selectedSessionName,
      setRightPanelVisible,
      sessionTabs.handleOpenSubagentTab,
      sessionTabs.selectedDbSessionId,
    ]
  );

  if (workspaceState.workspaceLoading) {
    return <Loading message="Loading workspace…" />;
  }

  if (!workspaceState.workspace) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-destructive">Workspace not found</p>
        <Button variant="outline" onClick={workspaceState.handleBackToWorkspaces}>
          Workspaces
        </Button>
      </div>
    );
  }

  const mainContent = (
    <div className="h-full flex flex-col min-w-0">
      <WorkspaceContentView
        workspaceId={workspaceState.workspaceId}
        sessions={sessionTabs.sessions}
        selectedSessionId={sessionTabs.selectedDbSessionId}
        sessionSummariesById={sessionTabs.sessionSummariesById}
        queuedMessageCount={sessionTabs.queuedMessageCount}
        isCreatingSession={header.isCreatingSession}
        isDeletingSession={sessionTabs.isDeletingSession}
        onSelectSession={sessionTabs.handleSelectSession}
        onCreateSession={sessionTabs.handleNewChat}
        onCloseSession={sessionTabs.handleCloseChatSession}
        onRestartSession={sessionTabs.handleRestartSession}
        maxSessions={sessionTabs.maxSessions}
        hasWorktreePath={sessionTabs.hasWorktreePath}
        emptyState={
          workspaceState.workspaceInitStatus?.phase === 'BLOCKED_FAILED' ? (
            <SessionlessSetupFailure
              retryAvailability={workspaceState.workspaceInitStatus.retryAvailability}
              workspaceId={workspaceState.workspaceId}
              banner={workspaceState.workspaceInitStatus.chatBanner}
              errorMessage={workspaceState.workspaceInitStatus.initErrorMessage}
            />
          ) : undefined
        }
      >
        {CONNECTED_CHAT_CONTENT}
      </WorkspaceContentView>
    </div>
  );

  const rightPanel = (
    <RightPanel
      workspaceId={workspaceState.workspaceId}
      isTakingScreenshots={isTakingScreenshots}
      onTakeScreenshots={handleTakeScreenshots}
      selectedSessionId={sessionTabs.selectedDbSessionId}
      selectedSessionName={selectedSessionName}
      selectedSessionReady={sessionTabs.selectedSessionReady}
      selectedSessionControlId={sessionTabs.selectedSessionControlId}
      selectedSessionControlRuntimeId={sessionTabs.selectedSessionControlRuntimeId}
      onOpenSubagent={handleOpenSubagent}
    />
  );

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {header.archivePending && <ArchivingOverlay />}

      <ScriptBanner
        workspaceId={workspaceState.workspaceId}
        isScriptFailed={workspaceState.isScriptFailed}
        workspaceInitStatus={workspaceState.workspaceInitStatus}
        setupWarningDismissed={workspaceState.setupWarningDismissed}
        dismissSetupWarning={workspaceState.dismissSetupWarning}
        resumeQueuedMessages={resumeQueuedMessages}
      />

      {isMobile ? (
        <>
          <div className="flex-1 min-h-0">{mainContent}</div>
          <WorkspaceToolsDrawer open={rightPanelVisible} onOpenChange={setRightPanelVisible}>
            {rightPanel}
          </WorkspaceToolsDrawer>
        </>
      ) : (
        <ResizablePanelGroup
          direction="horizontal"
          className="flex-1 overflow-hidden"
          autoSaveId="workspace-main-panel"
        >
          {/* NOTE: react-resizable-panels v4+ changed its API to use percentage strings. */}
          <ResizablePanel id="workspace-chat" defaultSize="70%" minSize="30%">
            {mainContent}
          </ResizablePanel>

          <WorkspaceSidePanel visible={rightPanelVisible}>{rightPanel}</WorkspaceSidePanel>
        </ResizablePanelGroup>
      )}

      <ArchiveWorkspaceDialog
        open={archiveDialog.open}
        onOpenChange={archiveDialog.setOpen}
        activeChildCount={archiveDialog.activeChildCount}
        onConfirm={archiveDialog.onConfirm}
      />
    </div>
  );
});
