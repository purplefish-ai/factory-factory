import type { Dispatch, SetStateAction } from 'react';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ArchiveWorkspaceDialog, RightPanel, WorkspaceContentView } from '@/components/workspace';
import type { WorkspaceSessionRuntimeSummary } from '@/components/workspace/session-tab-runtime';
import { Loading } from '@/frontend/components/loading';
import type {
  NewSessionProviderSelection,
  useSessionManagement,
  useWorkspaceData,
} from './use-workspace-detail';
import type { useWorkspaceInitStatus } from './use-workspace-detail-hooks';
import { ChatContent, type ChatContentProps } from './workspace-detail-chat-content';
import { WorkspaceHeader } from './workspace-detail-header';
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
  selectedProvider: NewSessionProviderSelection;
  setSelectedProvider: Dispatch<SetStateAction<NewSessionProviderSelection>>;
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
  maxSessions: ReturnType<typeof useWorkspaceData>['maxSessions'];
  hasWorktreePath: boolean;
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
  archiveDialog,
}: WorkspaceDetailViewProps) {
  if (workspaceState.workspaceLoading) {
    return <Loading message="Loading workspace..." />;
  }

  if (!workspaceState.workspace) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-destructive">Workspace not found</p>
        <Button variant="outline" onClick={workspaceState.handleBackToWorkspaces}>
          Back to workspaces
        </Button>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {header.archivePending && <ArchivingOverlay />}

      <WorkspaceHeader
        workspace={workspaceState.workspace}
        workspaceId={workspaceState.workspaceId}
        availableIdes={header.availableIdes}
        preferredIde={header.preferredIde}
        openInIde={header.openInIde}
        archivePending={header.archivePending}
        onArchiveRequest={header.handleArchiveRequest}
        handleQuickAction={header.handleQuickAction}
        selectedProvider={header.selectedProvider}
        setSelectedProvider={header.setSelectedProvider}
        running={header.running}
        isCreatingSession={header.isCreatingSession}
        hasChanges={header.hasChanges}
      />

      <ScriptBanner
        workspaceId={workspaceState.workspaceId}
        isScriptFailed={workspaceState.isScriptFailed}
        workspaceInitStatus={workspaceState.workspaceInitStatus}
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
              workspaceId={workspaceState.workspaceId}
              sessions={sessionTabs.sessions}
              selectedSessionId={sessionTabs.selectedDbSessionId}
              sessionSummariesById={sessionTabs.sessionSummariesById}
              isCreatingSession={header.isCreatingSession}
              isDeletingSession={sessionTabs.isDeletingSession}
              onSelectSession={sessionTabs.handleSelectSession}
              onCreateSession={sessionTabs.handleNewChat}
              onCloseSession={sessionTabs.handleCloseChatSession}
              maxSessions={sessionTabs.maxSessions}
              hasWorktreePath={sessionTabs.hasWorktreePath}
            >
              <ChatContent {...chat} />
            </WorkspaceContentView>
          </div>
        </ResizablePanel>

        {rightPanelVisible && (
          <>
            <ResizableHandle />
            <ResizablePanel defaultSize="30%" minSize="15%" maxSize="50%">
              <div className="h-full border-l">
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
              </div>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>

      <ArchiveWorkspaceDialog
        open={archiveDialog.open}
        onOpenChange={archiveDialog.setOpen}
        hasUncommitted={archiveDialog.hasUncommitted}
        onConfirm={archiveDialog.onConfirm}
      />
    </div>
  );
}
