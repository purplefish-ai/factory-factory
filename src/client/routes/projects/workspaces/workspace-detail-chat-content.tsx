import { AlertTriangle, ArrowDown, Loader2, Play, RefreshCw } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo } from 'react';
import type { useChatWebSocket } from '@/components/chat';
import {
  ChatInput,
  PermissionPrompt,
  QuestionPrompt,
  RewindConfirmationDialog,
  VirtualizedMessageList,
} from '@/components/chat';
import { Button } from '@/components/ui/button';
import type { CommandInfo, TokenStats } from '@/lib/chat-protocol';
import { groupAdjacentToolCalls } from '@/lib/chat-protocol';
import { getSessionRuntimeErrorMessage, type SessionRuntimeState } from '@/shared/session-runtime';
import type { WorkspaceInitBanner } from '@/shared/workspace-init';
import { useRetryWorkspaceInit } from './use-retry-workspace-init';

export interface ChatContentProps {
  workspaceId: string;
  messages: ReturnType<typeof useChatWebSocket>['messages'];
  sessionStatus: ReturnType<typeof useChatWebSocket>['sessionStatus'];
  sessionRuntime: SessionRuntimeState;
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
  slashCommands: CommandInfo[];
  slashCommandsLoaded: ReturnType<typeof useChatWebSocket>['slashCommandsLoaded'];
  tokenStats: TokenStats;
  rewindPreview: ReturnType<typeof useChatWebSocket>['rewindPreview'];
  startRewindPreview: ReturnType<typeof useChatWebSocket>['startRewindPreview'];
  confirmRewind: ReturnType<typeof useChatWebSocket>['confirmRewind'];
  cancelRewind: ReturnType<typeof useChatWebSocket>['cancelRewind'];
  getUuidForMessageId: ReturnType<typeof useChatWebSocket>['getUuidForMessageId'];
  acpConfigOptions: ReturnType<typeof useChatWebSocket>['acpConfigOptions'];
  setConfigOption: ReturnType<typeof useChatWebSocket>['setConfigOption'];
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
  sessionRuntime,
  messageCount,
}: {
  loadingSession: boolean;
  stopping: boolean;
  displayStartingState: boolean;
  running: boolean;
  pendingRequest: ReturnType<typeof useChatWebSocket>['pendingRequest'];
  sessionPhase: ReturnType<typeof useChatWebSocket>['sessionStatus']['phase'];
  sessionRuntime: SessionRuntimeState;
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
  if (sessionRuntime.phase === 'error') {
    return 'Agent failed to start. Type a message to retry...';
  }
  if (pendingRequest.type === 'permission' && pendingRequest.request.toolName === 'ExitPlanMode') {
    return 'Approve the plan or keep planning...';
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

export const ChatContent = memo(function ChatContent(props: ChatContentProps) {
  const autoStartPending = props.autoStartPending ?? false;

  const { retry, retryInit } = useRetryWorkspaceInit(props.workspaceId);
  const groupedMessages = useMemo(() => groupAdjacentToolCalls(props.messages), [props.messages]);
  const queuedMessageIds = useMemo(
    () => new Set(props.queuedMessages.map((msg) => msg.id)),
    [props.queuedMessages]
  );

  const handleHeightChange = useCallback(() => {
    if (props.isNearBottom && props.viewportRef.current) {
      props.viewportRef.current.scrollTo({
        top: props.viewportRef.current.scrollHeight,
        behavior: 'instant',
      });
    }
  }, [props.isNearBottom, props.viewportRef]);

  const running = props.sessionStatus.phase === 'running';
  const stopping = props.sessionStatus.phase === 'stopping';
  const displayStartingState = shouldShowStartingState(props.sessionStatus.phase, autoStartPending);
  const loadingSession = props.sessionStatus.phase === 'loading';
  const rewindEnabled = props.chatCapabilities.rewind.enabled;

  const permissionRequestId =
    props.pendingRequest.type === 'permission' ? props.pendingRequest.request.requestId : null;
  const isPlanApproval =
    props.pendingRequest.type === 'permission' &&
    props.pendingRequest.request.toolName === 'ExitPlanMode';

  useEffect(() => {
    if (!(isPlanApproval && permissionRequestId)) {
      return;
    }
    const activeElement = document.activeElement;
    if (activeElement && activeElement !== document.body) {
      return;
    }
    props.inputRef?.current?.focus();
  }, [isPlanApproval, permissionRequestId, props.inputRef]);

  const placeholder = getInputPlaceholder({
    loadingSession,
    stopping,
    displayStartingState,
    running,
    pendingRequest: props.pendingRequest,
    sessionPhase: props.sessionStatus.phase,
    sessionRuntime: props.sessionRuntime,
    messageCount: props.messages.length,
  });
  const sessionRuntimeError = getSessionRuntimeErrorMessage(props.sessionRuntime);
  const sessionRuntimeBanner: WorkspaceInitBanner | null =
    props.sessionRuntime.phase === 'error' && sessionRuntimeError
      ? {
          kind: 'error',
          message: sessionRuntimeError,
          showRetry: false,
          showPlay: false,
        }
      : null;

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div ref={props.viewportRef} className="flex-1 min-h-0 overflow-y-auto">
        {sessionRuntimeBanner && (
          <InitStatusBanner
            banner={sessionRuntimeBanner}
            retryPending={false}
            onRetry={() => undefined}
            onPlay={() => undefined}
          />
        )}
        {props.initBanner && props.initBanner.kind !== 'info' && (
          <InitStatusBanner
            banner={props.initBanner}
            retryPending={retryInit.isPending}
            onRetry={retry}
            onPlay={props.resumeQueuedMessages}
          />
        )}
        <VirtualizedMessageList
          workspaceId={props.workspaceId}
          messages={groupedMessages}
          running={running}
          startingSession={displayStartingState}
          loadingSession={loadingSession}
          latestThinking={props.latestThinking ?? null}
          scrollContainerRef={props.viewportRef}
          onScroll={props.onScroll}
          messagesEndRef={props.messagesEndRef}
          isNearBottom={props.isNearBottom}
          queuedMessageIds={queuedMessageIds}
          onRemoveQueuedMessage={props.removeQueuedMessage}
          isCompacting={props.isCompacting}
          getUuidForMessageId={props.getUuidForMessageId}
          onRewindToMessage={rewindEnabled ? props.startRewindPreview : undefined}
          initBanner={props.initBanner}
        />
      </div>

      {!props.isNearBottom && (
        <div className="absolute bottom-32 left-1/2 z-10 -translate-x-1/2">
          <Button
            variant="secondary"
            size="sm"
            onClick={props.scrollToBottom}
            className="rounded-full shadow-lg"
          >
            <ArrowDown className="h-4 w-4 mr-1" />
            Scroll to bottom
          </Button>
        </div>
      )}

      <div className="z-20 border-t bg-background pb-safe">
        <PermissionPrompt
          permission={
            props.pendingRequest.type === 'permission' ? props.pendingRequest.request : null
          }
          onApprove={props.approvePermission}
        />
        <QuestionPrompt
          question={props.pendingRequest.type === 'question' ? props.pendingRequest.request : null}
          onAnswer={props.answerQuestion}
        />

        <ChatInput
          onSend={props.sendMessage}
          onStop={props.stopChat}
          disabled={!props.connected || loadingSession}
          running={running}
          stopping={stopping}
          inputRef={props.inputRef}
          placeholder={placeholder}
          settings={props.chatSettings}
          capabilities={props.chatCapabilities}
          onSettingsChange={props.updateSettings}
          value={props.inputDraft}
          onChange={props.setInputDraft}
          attachments={props.inputAttachments}
          onAttachmentsChange={props.setInputAttachments}
          onHeightChange={handleHeightChange}
          pendingMessageCount={props.pendingMessages.size}
          slashCommands={props.slashCommands}
          slashCommandsLoaded={props.slashCommandsLoaded}
          tokenStats={props.tokenStats}
          workspaceId={props.workspaceId}
          acpConfigOptions={props.acpConfigOptions}
          onSetConfigOption={props.setConfigOption}
        />
      </div>

      <RewindConfirmationDialog
        rewindPreview={props.rewindPreview}
        onConfirm={props.confirmRewind}
        onCancel={props.cancelRewind}
      />
    </div>
  );
});
