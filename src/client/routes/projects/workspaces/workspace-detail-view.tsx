import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Loading } from '@/client/components/loading';
import { type SubagentSelection, SubagentTranscriptView } from '@/client/features/subagents';
import {
  ArchiveWorkspaceDialog,
  RightPanel,
  WorkspaceContentView,
} from '@/client/features/workspace';
import type { WorkspaceSessionRuntimeSummary } from '@/client/features/workspace/session-tab-runtime';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import type { SessionProviderValue } from '@/lib/session-provider-selection';
import { cn } from '@/lib/utils';
import { AutoIterationProgressBanner } from './auto-iteration-progress-banner';
import type { useSessionManagement, useWorkspaceData } from './use-workspace-detail';
import type { useWorkspaceInitStatus } from './use-workspace-detail-hooks';
import { ChatContent, type ChatContentProps } from './workspace-detail-chat-content';
import { getVisibleInitBanner } from './workspace-detail-container.utils';
import { ArchivingOverlay, ScriptFailedBanner } from './workspace-overlays';

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
  availableIdes: ReturnType<typeof useSessionManagement>['availableIdes'];
  preferredIde: string;
  openInIde: ReturnType<typeof useSessionManagement>['openInIde'];
  handleArchiveRequest: () => void;
  handleQuickAction: ReturnType<typeof useSessionManagement>['handleQuickAction'];
  running: boolean;
  isCreatingSession: boolean;
  hasChanges: boolean | undefined;
}

interface SessionTabsProps {
  sessions: ReturnType<typeof useWorkspaceData>['sessions'];
  selectedDbSessionId: string | null;
  selectedSessionReady: boolean;
  sessionSummariesById: ReadonlyMap<string, WorkspaceSessionRuntimeSummary>;
  isDeletingSession: boolean;
  handleSelectSession: ReturnType<typeof useSessionManagement>['handleSelectSession'];
  handleNewChat: ReturnType<typeof useSessionManagement>['handleNewChat'];
  handleCloseChatSession: ReturnType<typeof useSessionManagement>['handleCloseSession'];
  handleQuickAction: ReturnType<typeof useSessionManagement>['handleQuickAction'];
  handleRestartSession: () => void;
  maxSessions: ReturnType<typeof useWorkspaceData>['maxSessions'];
  hasWorktreePath: boolean;
  selectedProvider: SessionProviderValue;
  setSelectedProvider: Dispatch<SetStateAction<SessionProviderValue>>;
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
  chat: ChatContentProps;
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
}: {
  workspaceId: string;
  isScriptFailed: boolean;
  workspaceInitStatus: WorkspaceStateProps['workspaceInitStatus'];
  setupWarningDismissed: boolean | null;
  dismissSetupWarning: () => void;
}) {
  const visibleBanner = getVisibleInitBanner(
    workspaceInitStatus?.chatBanner,
    setupWarningDismissed
  );
  if (isScriptFailed && visibleBanner) {
    return (
      <ScriptFailedBanner
        workspaceId={workspaceId}
        initErrorMessage={workspaceInitStatus?.initErrorMessage ?? null}
        initOutput={workspaceInitStatus?.initOutput ?? null}
        hasStartupScript={workspaceInitStatus?.hasStartupScript ?? false}
        showDismiss={visibleBanner.showDismiss}
        onDismiss={dismissSetupWarning}
      />
    );
  }
  return null;
}

export function WorkspaceDetailView({
  workspaceState,
  header,
  sessionTabs,
  chat,
  rightPanelVisible,
  setRightPanelVisible,
  archiveDialog,
}: WorkspaceDetailViewProps) {
  const isMobile = useIsMobile();
  const [isTakingScreenshots, setIsTakingScreenshots] = useState(false);
  const [subagentDrillIn, setSubagentDrillIn] = useState<{
    scope: string;
    selection: SubagentSelection;
  } | null>(null);
  const parentChatScrollTopRef = useRef<number | null>(null);
  const restoreParentScrollRef = useRef(false);
  const selectedSessionIndex =
    sessionTabs.sessions?.findIndex((session) => session.id === sessionTabs.selectedDbSessionId) ??
    -1;
  const selectedSession =
    selectedSessionIndex >= 0 ? sessionTabs.sessions?.[selectedSessionIndex] : undefined;
  const selectedSessionName = selectedSession
    ? selectedSession.name?.trim() || `Session ${selectedSessionIndex + 1}`
    : null;
  const drillInScope = `${workspaceState.workspaceId}:${sessionTabs.selectedDbSessionId ?? ''}`;
  const selectedSubagent =
    subagentDrillIn?.scope === drillInScope ? subagentDrillIn.selection : null;

  useEffect(() => {
    parentChatScrollTopRef.current = null;
    restoreParentScrollRef.current = false;
    setSubagentDrillIn((current) => (current?.scope === drillInScope ? current : null));
  }, [drillInScope]);

  useLayoutEffect(() => {
    if (selectedSubagent || !restoreParentScrollRef.current) {
      return;
    }
    restoreParentScrollRef.current = false;
    const scrollTop = parentChatScrollTopRef.current;
    parentChatScrollTopRef.current = null;
    const viewport = chat.viewportRef.current;
    if (scrollTop === null || !viewport) {
      return;
    }
    viewport.scrollTop = scrollTop;
    chat.onScroll();
  }, [chat.onScroll, chat.viewportRef, selectedSubagent]);

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
      if (!selectedSubagent) {
        parentChatScrollTopRef.current = chat.viewportRef.current?.scrollTop ?? null;
      }
      restoreParentScrollRef.current = false;
      setSubagentDrillIn({
        scope: drillInScope,
        selection: { ...selection, parentSessionName: selectedSessionName },
      });
    },
    [
      chat.viewportRef,
      drillInScope,
      selectedSessionName,
      selectedSubagent,
      sessionTabs.selectedDbSessionId,
    ]
  );

  const handleBackFromSubagent = useCallback(() => {
    restoreParentScrollRef.current = true;
    setSubagentDrillIn(null);
  }, []);

  if (workspaceState.workspaceLoading) {
    return <Loading message="Loading workspace..." />;
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
        isCreatingSession={header.isCreatingSession}
        isDeletingSession={sessionTabs.isDeletingSession}
        onSelectSession={sessionTabs.handleSelectSession}
        onCreateSession={sessionTabs.handleNewChat}
        onCloseSession={sessionTabs.handleCloseChatSession}
        onRestartSession={sessionTabs.handleRestartSession}
        onQuickAction={sessionTabs.handleQuickAction}
        maxSessions={sessionTabs.maxSessions}
        hasWorktreePath={sessionTabs.hasWorktreePath}
        selectedProvider={sessionTabs.selectedProvider}
        setSelectedProvider={sessionTabs.setSelectedProvider}
      >
        <div className={cn('h-full', selectedSubagent && 'hidden')}>
          <ChatContent {...chat} />
        </div>
        {selectedSubagent && (
          <SubagentTranscriptView
            workspaceId={workspaceState.workspaceId}
            selection={selectedSubagent}
            onBack={handleBackFromSubagent}
          />
        )}
      </WorkspaceContentView>
    </div>
  );

  const rightPanel = (
    <RightPanel
      workspaceId={workspaceState.workspaceId}
      messages={chat.messages}
      isTakingScreenshots={isTakingScreenshots}
      onTakeScreenshots={handleTakeScreenshots}
      selectedSessionId={sessionTabs.selectedDbSessionId}
      selectedSessionName={selectedSessionName}
      selectedSessionReady={sessionTabs.selectedSessionReady}
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
      />

      <AutoIterationProgressBanner
        workspaceId={workspaceState.workspaceId}
        mode={workspaceState.workspace?.mode}
      />

      {isMobile ? (
        <>
          <div className="flex-1 min-h-0">{mainContent}</div>
          <Sheet open={rightPanelVisible} onOpenChange={setRightPanelVisible}>
            <SheetContent
              side="bottom"
              className="h-[85dvh] w-full max-w-none p-0 pt-12 [&>button]:right-3 [&>button]:top-3 [&>button]:z-30"
            >
              <SheetHeader className="sr-only">
                <SheetTitle>Workspace Side Panel</SheetTitle>
                <SheetDescription>
                  Browse files, diffs, tasks, logs, and terminals for this workspace.
                </SheetDescription>
              </SheetHeader>
              <div className="h-full">{rightPanel}</div>
            </SheetContent>
          </Sheet>
        </>
      ) : (
        <ResizablePanelGroup
          direction="horizontal"
          className="flex-1 overflow-hidden"
          autoSaveId="workspace-main-panel"
        >
          {/* NOTE: react-resizable-panels v4+ changed its API to use percentage strings. */}
          <ResizablePanel defaultSize="70%" minSize="30%">
            {mainContent}
          </ResizablePanel>

          {rightPanelVisible && (
            <>
              <ResizableHandle />
              <ResizablePanel defaultSize="30%" minSize="15%" maxSize="50%">
                <div className="h-full border-l">{rightPanel}</div>
              </ResizablePanel>
            </>
          )}
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
}
