import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { useChatWebSocket } from '@/components/chat';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ArchiveWorkspaceDialog, RightPanel, WorkspaceContentView } from '@/components/workspace';
import { Loading } from '@/frontend/components/loading';

import type { useSessionManagement, useWorkspaceData } from './use-workspace-detail';
import type { useWorkspaceInitStatus } from './use-workspace-detail-hooks';
import { ChatContent } from './workspace-detail-chat-content';
import { WorkspaceHeader } from './workspace-detail-header';
import { ArchivingOverlay, ScriptFailedBanner } from './workspace-overlays';

export interface WorkspaceDetailViewProps {
  workspaceLoading: boolean;
  workspace: ReturnType<typeof useWorkspaceData>['workspace'];
  workspaceId: string;
  handleBackToWorkspaces: () => void;
  isScriptFailed: boolean;
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
  selectedDbSessionId: string | null;
  runningSessionIds: ReadonlySet<string>;
  isDeletingSession: boolean;
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
  resumeQueuedMessages: ReturnType<typeof useChatWebSocket>['resumeQueuedMessages'];
  latestThinking: ReturnType<typeof useChatWebSocket>['latestThinking'];
  pendingMessages: ReturnType<typeof useChatWebSocket>['pendingMessages'];
  isCompacting: ReturnType<typeof useChatWebSocket>['isCompacting'];
  permissionMode: ReturnType<typeof useChatWebSocket>['permissionMode'];
  slashCommands: ReturnType<typeof useChatWebSocket>['slashCommands'];
  slashCommandsLoaded: ReturnType<typeof useChatWebSocket>['slashCommandsLoaded'];
  tokenStats: ReturnType<typeof useChatWebSocket>['tokenStats'];
  rewindPreview: ReturnType<typeof useChatWebSocket>['rewindPreview'];
  startRewindPreview: ReturnType<typeof useChatWebSocket>['startRewindPreview'];
  confirmRewind: ReturnType<typeof useChatWebSocket>['confirmRewind'];
  cancelRewind: ReturnType<typeof useChatWebSocket>['cancelRewind'];
  getUuidForMessageId: ReturnType<typeof useChatWebSocket>['getUuidForMessageId'];
  isIssueAutoStartPending: boolean;
  rightPanelVisible: boolean;
  archiveDialogOpen: boolean;
  setArchiveDialogOpen: Dispatch<SetStateAction<boolean>>;
  hasUncommitted: boolean;
  handleArchive: (commitUncommitted: boolean) => void;
}

function ScriptBanner({
  workspaceId,
  isScriptFailed,
  workspaceInitStatus,
}: {
  workspaceId: string;
  isScriptFailed: boolean;
  workspaceInitStatus: WorkspaceDetailViewProps['workspaceInitStatus'];
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
  workspaceLoading,
  workspace,
  workspaceId,
  handleBackToWorkspaces,
  isScriptFailed,
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
  selectedDbSessionId,
  runningSessionIds,
  isDeletingSession,
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
  isIssueAutoStartPending,
  rightPanelVisible,
  archiveDialogOpen,
  setArchiveDialogOpen,
  hasUncommitted,
  handleArchive,
}: WorkspaceDetailViewProps) {
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

      <ScriptBanner
        workspaceId={workspaceId}
        isScriptFailed={isScriptFailed}
        workspaceInitStatus={workspaceInitStatus}
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
              selectedSessionId={selectedDbSessionId}
              runningSessionIds={runningSessionIds}
              sessionStatus={sessionStatus}
              processStatus={processStatus}
              isCreatingSession={isCreatingSession}
              isDeletingSession={isDeletingSession}
              onSelectSession={handleSelectSession}
              onCreateSession={handleNewChat}
              onCloseSession={handleCloseChatSession}
              maxSessions={maxSessions}
              hasWorktreePath={hasWorktreePath}
            >
              <ChatContent
                workspaceId={workspaceId}
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
                resumeQueuedMessages={resumeQueuedMessages}
                latestThinking={latestThinking}
                pendingMessages={pendingMessages}
                isCompacting={isCompacting}
                permissionMode={permissionMode}
                slashCommands={slashCommands}
                slashCommandsLoaded={slashCommandsLoaded}
                tokenStats={tokenStats}
                rewindPreview={rewindPreview}
                startRewindPreview={startRewindPreview}
                confirmRewind={confirmRewind}
                cancelRewind={cancelRewind}
                getUuidForMessageId={getUuidForMessageId}
                autoStartPending={isIssueAutoStartPending}
                initBanner={workspaceInitStatus?.chatBanner ?? null}
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
        onConfirm={handleArchive}
      />
    </div>
  );
}
