import type { Dispatch, SetStateAction } from 'react';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { ArchiveWorkspaceDialog, RightPanel, WorkspaceContentView } from '@/components/workspace';
import type { WorkspaceSessionRuntimeSummary } from '@/components/workspace/session-tab-runtime';
import { Loading } from '@/frontend/components/loading';
import { useIsMobile } from '@/hooks/use-mobile';
import type { SessionProviderValue } from '@/lib/session-provider-selection';
import type { useSessionManagement, useWorkspaceData } from './use-workspace-detail';
import type { useWorkspaceInitStatus } from './use-workspace-detail-hooks';
import { ChatContent, type ChatContentProps } from './workspace-detail-chat-content';
import { ArchivingOverlay, ScriptFailedBanner } from './workspace-overlays';

interface WorkspaceStateProps {
  workspaceLoading: boolean;
  workspace: ReturnType<typeof useWorkspaceData>['workspace'];
  workspaceId: string;
  handleBackToWorkspaces: () => void;
  isScriptFailed: boolean;
  workspaceInitStatus: ReturnType<typeof useWorkspaceInitStatus>['workspaceInitStatus'];
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
  sessionSummariesById: ReadonlyMap<string, WorkspaceSessionRuntimeSummary>;
  isDeletingSession: boolean;
  handleSelectSession: ReturnType<typeof useSessionManagement>['handleSelectSession'];
  handleNewChat: ReturnType<typeof useSessionManagement>['handleNewChat'];
  handleCloseChatSession: ReturnType<typeof useSessionManagement>['handleCloseSession'];
  handleQuickAction: ReturnType<typeof useSessionManagement>['handleQuickAction'];
  maxSessions: ReturnType<typeof useWorkspaceData>['maxSessions'];
  hasWorktreePath: boolean;
  selectedProvider: SessionProviderValue;
  setSelectedProvider: Dispatch<SetStateAction<SessionProviderValue>>;
}

interface ArchiveDialogProps {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  hasUncommitted: boolean;
  onConfirm: (commitUncommitted: boolean) => void;
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
}: {
  workspaceId: string;
  isScriptFailed: boolean;
  workspaceInitStatus: WorkspaceStateProps['workspaceInitStatus'];
}) {
  if (isScriptFailed) {
    return (
      <ScriptFailedBanner
        workspaceId={workspaceId}
        initErrorMessage={workspaceInitStatus?.initErrorMessage ?? null}
        initOutput={workspaceInitStatus?.initOutput ?? null}
        hasStartupScript={workspaceInitStatus?.hasStartupScript ?? false}
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
        onQuickAction={sessionTabs.handleQuickAction}
        maxSessions={sessionTabs.maxSessions}
        hasWorktreePath={sessionTabs.hasWorktreePath}
        selectedProvider={sessionTabs.selectedProvider}
        setSelectedProvider={sessionTabs.setSelectedProvider}
      >
        <ChatContent {...chat} />
      </WorkspaceContentView>
    </div>
  );

  const rightPanel = (
    <RightPanel
      workspaceId={workspaceState.workspaceId}
      messages={chat.messages}
      onTakeScreenshots={() =>
        header.handleQuickAction(
          'Take Screenshots',
          'Take a screenshot of the workspace dev app using Playwright MCP tools. Read factory-factory.json for the scripts.run command, pick a free port, replace {port}, and start the dev server in the background. Once ready, determine the most relevant screen and save a screenshot to .factory-factory/screenshots/ with a descriptive filename.'
        )
      }
    />
  );

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {header.archivePending && <ArchivingOverlay />}

      <ScriptBanner
        workspaceId={workspaceState.workspaceId}
        isScriptFailed={workspaceState.isScriptFailed}
        workspaceInitStatus={workspaceState.workspaceInitStatus}
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
        hasUncommitted={archiveDialog.hasUncommitted}
        onConfirm={archiveDialog.onConfirm}
      />
    </div>
  );
}
