import { AlertTriangle, ArrowDown, Loader2, Play, RefreshCw } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo } from 'react';
import type { useChatWebSocket } from '@/components/chat';
import {
  AgentLiveDock,
  ChatInput,
  PermissionPrompt,
  QuestionPrompt,
  RewindConfirmationDialog,
  VirtualizedMessageList,
} from '@/components/chat';
import { Button } from '@/components/ui/button';
import type { CommandInfo, TokenStats } from '@/lib/chat-protocol';
import { groupAdjacentToolCalls, isToolSequence } from '@/lib/chat-protocol';
import type { WorkspaceInitBanner } from '@/shared/workspace-init';
import { useRetryWorkspaceInit } from './use-retry-workspace-init';

export interface ChatContentProps {
  workspaceId: string;
  messages: ReturnType<typeof useChatWebSocket>['messages'];
  sessionStatus: ReturnType<typeof useChatWebSocket>['sessionStatus'];
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  isNearBottom: boolean;
  scrollToBottom: () => void;
  onScroll: () => void;
  pendingRequest: ReturnType<typeof useChatWebSocket>['pendingRequest'];
  approvePermission: ReturnType<typeof useChatWebSocket>['approvePermission'];
  answerQuestion: ReturnType<typeof useChatWebSocket>['answerQuestion'];
  connected: boolean;
  sendMessage: ReturnType<typeof useChatWebSocket>['sendMessage'];
  stopChat: ReturnType<typeof useChatWebSocket>['stopChat'];
  inputRef: ReturnType<typeof useChatWebSocket>['inputRef'];
  chatSettings: ReturnType<typeof useChatWebSocket>['chatSettings'];
  chatCapabilities: ReturnType<typeof useChatWebSocket>['chatCapabilities'];
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
  slashCommands: CommandInfo[];
  slashCommandsLoaded: ReturnType<typeof useChatWebSocket>['slashCommandsLoaded'];
  tokenStats: TokenStats;
  rewindPreview: ReturnType<typeof useChatWebSocket>['rewindPreview'];
  startRewindPreview: ReturnType<typeof useChatWebSocket>['startRewindPreview'];
  confirmRewind: ReturnType<typeof useChatWebSocket>['confirmRewind'];
  cancelRewind: ReturnType<typeof useChatWebSocket>['cancelRewind'];
  getUuidForMessageId: ReturnType<typeof useChatWebSocket>['getUuidForMessageId'];
  acpPlan: ReturnType<typeof useChatWebSocket>['acpPlan'];
  toolProgress: ReturnType<typeof useChatWebSocket>['toolProgress'];
  autoStartPending?: boolean;
  initBanner: WorkspaceInitBanner | null;
}

interface InitStatusBannerProps {
  banner: WorkspaceInitBanner;
  retryPending: boolean;
  onRetry: () => void;
  onPlay: () => void;
}

function shouldShowStartingState(
  sessionPhase: ReturnType<typeof useChatWebSocket>['sessionStatus']['phase'],
  autoStartPending: boolean
): boolean {
  return sessionPhase === 'starting' || autoStartPending;
}

function getInputPlaceholder({
  loadingSession,
  stopping,
  displayStartingState,
  running,
  pendingRequest,
  sessionPhase,
  messageCount,
}: {
  loadingSession: boolean;
  stopping: boolean;
  displayStartingState: boolean;
  running: boolean;
  pendingRequest: ReturnType<typeof useChatWebSocket>['pendingRequest'];
  sessionPhase: ReturnType<typeof useChatWebSocket>['sessionStatus']['phase'];
  messageCount: number;
}): string {
  if (loadingSession) {
    return 'Loading session...';
  }
  if (stopping) {
    return 'Stopping...';
  }
  if (displayStartingState && !running) {
    return 'Agent is starting...';
  }
  if (pendingRequest.type === 'permission' && pendingRequest.request.toolName === 'ExitPlanMode') {
    return 'Type feedback to revise the plan...';
  }
  if (running) {
    return 'Message will be queued...';
  }
  if (sessionPhase === 'ready' && messageCount === 0) {
    return 'Type a message to start the agent...';
  }
  return 'Type a message...';
}

function getInitBannerClass(kind: WorkspaceInitBanner['kind']): string {
  if (kind === 'error') {
    return 'border-red-200 bg-red-50 text-red-900';
  }
  if (kind === 'warning') {
    return 'border-yellow-200 bg-yellow-50 text-yellow-900';
  }
  return 'border-blue-200 bg-blue-50 text-blue-900';
}

const InitStatusBanner = memo(function InitStatusBanner({
  banner,
  retryPending,
  onRetry,
  onPlay,
}: InitStatusBannerProps) {
  const hasActions = banner.showRetry || banner.showPlay;

  return (
    <div className="px-4 pt-4">
      <div
        className={[
          'rounded-md border p-3 text-sm flex items-start gap-3',
          getInitBannerClass(banner.kind),
        ].join(' ')}
      >
        {banner.kind === 'info' ? (
          <Loader2 className="h-4 w-4 mt-0.5 shrink-0 animate-spin" />
        ) : (
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <p>{banner.message}</p>
          {hasActions && (
            <div className="mt-2 flex items-center gap-2">
              {banner.showRetry && (
                <Button size="sm" variant="outline" disabled={retryPending} onClick={onRetry}>
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                  Retry setup
                </Button>
              )}
              {banner.showPlay && (
                <Button size="sm" onClick={onPlay}>
                  <Play className="h-3.5 w-3.5 mr-1.5" />
                  Dispatch queued messages
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

export const ChatContent = memo(function ChatContent({
  workspaceId,
  messages,
  sessionStatus,
  messagesEndRef,
  viewportRef,
  isNearBottom,
  scrollToBottom,
  onScroll,
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
  permissionMode,
  slashCommands,
  slashCommandsLoaded,
  tokenStats,
  rewindPreview,
  startRewindPreview,
  confirmRewind,
  cancelRewind,
  getUuidForMessageId,
  acpPlan,
  toolProgress,
  autoStartPending = false,
  initBanner,
}: ChatContentProps) {
  const { retry, retryInit } = useRetryWorkspaceInit(workspaceId);
  const groupedMessages = useMemo(() => groupAdjacentToolCalls(messages), [messages]);
  const latestToolSequence = useMemo(() => {
    for (let i = groupedMessages.length - 1; i >= 0; i -= 1) {
      const item = groupedMessages[i];
      if (!item) {
        continue;
      }
      if (isToolSequence(item)) {
        return item;
      }
    }
    return null;
  }, [groupedMessages]);

  const queuedMessageIds = useMemo(
    () => new Set(queuedMessages.map((msg) => msg.id)),
    [queuedMessages]
  );

  const handleHeightChange = useCallback(() => {
    if (isNearBottom && viewportRef.current) {
      viewportRef.current.scrollTo({
        top: viewportRef.current.scrollHeight,
        behavior: 'instant',
      });
    }
  }, [isNearBottom, viewportRef]);

  const running = sessionStatus.phase === 'running';
  const stopping = sessionStatus.phase === 'stopping';
  const displayStartingState = shouldShowStartingState(sessionStatus.phase, autoStartPending);
  const loadingSession = sessionStatus.phase === 'loading';
  const rewindEnabled = chatCapabilities.rewind.enabled;

  const permissionRequestId =
    pendingRequest.type === 'permission' ? pendingRequest.request.requestId : null;
  const isPlanApproval =
    pendingRequest.type === 'permission' && pendingRequest.request.toolName === 'ExitPlanMode';

  useEffect(() => {
    if (!(isPlanApproval && permissionRequestId)) {
      return;
    }
    const activeElement = document.activeElement;
    if (activeElement && activeElement !== document.body) {
      return;
    }
    inputRef?.current?.focus();
  }, [isPlanApproval, permissionRequestId, inputRef]);

  const placeholder = getInputPlaceholder({
    loadingSession,
    stopping,
    displayStartingState,
    running,
    pendingRequest,
    sessionPhase: sessionStatus.phase,
    messageCount: messages.length,
  });

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div ref={viewportRef} className="flex-1 min-h-0 overflow-y-auto">
        {initBanner && initBanner.kind !== 'info' && (
          <InitStatusBanner
            banner={initBanner}
            retryPending={retryInit.isPending}
            onRetry={retry}
            onPlay={resumeQueuedMessages}
          />
        )}
        <VirtualizedMessageList
          messages={groupedMessages}
          running={running}
          startingSession={displayStartingState}
          loadingSession={loadingSession}
          scrollContainerRef={viewportRef}
          onScroll={onScroll}
          messagesEndRef={messagesEndRef}
          isNearBottom={isNearBottom}
          queuedMessageIds={queuedMessageIds}
          onRemoveQueuedMessage={removeQueuedMessage}
          isCompacting={isCompacting}
          getUuidForMessageId={getUuidForMessageId}
          onRewindToMessage={rewindEnabled ? startRewindPreview : undefined}
          initBanner={initBanner}
        />
      </div>

      {!isNearBottom && (
        <div className="absolute bottom-28 left-1/2 -translate-x-1/2 z-10">
          <Button
            variant="secondary"
            size="sm"
            onClick={scrollToBottom}
            className="rounded-full shadow-lg"
          >
            <ArrowDown className="h-4 w-4 mr-1" />
            Scroll to bottom
          </Button>
        </div>
      )}

      <div className="border-t">
        <AgentLiveDock
          workspaceId={workspaceId}
          running={running}
          starting={displayStartingState}
          stopping={stopping}
          permissionMode={permissionMode}
          latestThinking={latestThinking ?? null}
          latestToolSequence={latestToolSequence}
          acpPlan={acpPlan}
          toolProgress={toolProgress}
        />
        <PermissionPrompt
          permission={pendingRequest.type === 'permission' ? pendingRequest.request : null}
          onApprove={approvePermission}
        />
        <QuestionPrompt
          question={pendingRequest.type === 'question' ? pendingRequest.request : null}
          onAnswer={answerQuestion}
        />

        <ChatInput
          onSend={sendMessage}
          onStop={stopChat}
          disabled={!connected || loadingSession}
          running={running}
          stopping={stopping}
          inputRef={inputRef}
          placeholder={placeholder}
          settings={chatSettings}
          capabilities={chatCapabilities}
          onSettingsChange={updateSettings}
          value={inputDraft}
          onChange={setInputDraft}
          attachments={inputAttachments}
          onAttachmentsChange={setInputAttachments}
          onHeightChange={handleHeightChange}
          pendingMessageCount={pendingMessages.size}
          slashCommands={slashCommands}
          slashCommandsLoaded={slashCommandsLoaded}
          tokenStats={tokenStats}
          workspaceId={workspaceId}
        />
      </div>

      <RewindConfirmationDialog
        rewindPreview={rewindPreview}
        onConfirm={confirmRewind}
        onCancel={cancelRewind}
      />
    </div>
  );
});
