import { memo, useCallback, useEffect, useMemo } from 'react';
import type { useChatWebSocket } from '@/client/features/chat';
import {
  ChatInput,
  PermissionPrompt,
  QuestionPrompt,
  RewindConfirmationDialog,
  useGroupedChatMessages,
  ChatTranscript,
  type TranscriptScrollOptions,
} from '@/client/features/chat';
import { useSubagentTimelineMessages } from '@/client/features/subagents';
import { VoiceModeToggle } from '@/client/features/voice';
import type { CommandInfo, TokenStats } from '@/lib/chat-protocol';
import { getSessionRuntimeErrorMessage, type SessionRuntimeState } from '@/shared/session-runtime';
import type { WorkspaceInitBanner } from '@/shared/workspace-init';
import { useRetryWorkspaceInit } from './use-retry-workspace-init';
import { InitStatusBanner, type InitStatusBannerProps } from './workspace-init-status-banner';

export interface ChatContentProps {
  workspaceId: string;
  sessionId: string | null;
  codexAccountId?: string | null;
  resolveWorkspaceFileLink?: (href: string) => string | null;
  onWorkspaceFileLink?: (path: string) => void;
  onOpenAgents?: () => void;
  messages: ReturnType<typeof useChatWebSocket>['messages'];
  acpPlan?: ReturnType<typeof useChatWebSocket>['acpPlan'];
  sessionStatus: ReturnType<typeof useChatWebSocket>['sessionStatus'];
  sessionRuntime: SessionRuntimeState;
  transcriptScroll: TranscriptScrollOptions;
  pendingRequest: ReturnType<typeof useChatWebSocket>['pendingRequest'];
  approvePermission: ReturnType<typeof useChatWebSocket>['approvePermission'];
  answerQuestion: ReturnType<typeof useChatWebSocket>['answerQuestion'];
  connected: boolean;
  sendMessage: ReturnType<typeof useChatWebSocket>['sendMessage'];
  stopChat: ReturnType<typeof useChatWebSocket>['stopChat'];
  inputRef: ReturnType<typeof useChatWebSocket>['inputRef'];
  chatSettings: ReturnType<typeof useChatWebSocket>['chatSettings'];
  chatCapabilities: ReturnType<typeof useChatWebSocket>['chatCapabilities'];
  chatCapabilitiesLoaded?: boolean;
  updateSettings: ReturnType<typeof useChatWebSocket>['updateSettings'];
  inputDraft: ReturnType<typeof useChatWebSocket>['inputDraft'];
  setInputDraft: ReturnType<typeof useChatWebSocket>['setInputDraft'];
  inputAttachments: ReturnType<typeof useChatWebSocket>['inputAttachments'];
  setInputAttachments: ReturnType<typeof useChatWebSocket>['setInputAttachments'];
  queuedMessages: ReturnType<typeof useChatWebSocket>['queuedMessages'];
  removeQueuedMessage: ReturnType<typeof useChatWebSocket>['removeQueuedMessage'];
  steerQueuedMessage: ReturnType<typeof useChatWebSocket>['steerQueuedMessage'];
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
  isScriptFailed: boolean;
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
  promptInFlight,
  pendingRequest,
  sessionPhase,
  sessionRuntime,
  messageCount,
}: {
  loadingSession: boolean;
  stopping: boolean;
  displayStartingState: boolean;
  running: boolean;
  promptInFlight: boolean;
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
    return 'Agent encountered an error. Type a message to retry...';
  }
  if (pendingRequest.type === 'permission' && pendingRequest.request.toolName === 'ExitPlanMode') {
    return 'Approve the plan or keep planning...';
  }
  if (promptInFlight) {
    return 'Message will be queued...';
  }
  if (sessionPhase === 'ready' && messageCount === 0) {
    return 'Type a message to start the agent...';
  }
  return 'Type a message...';
}

function getVisibleInitBanner(
  banner: WorkspaceInitBanner | null | undefined,
  isScriptFailed: boolean | undefined
) {
  return banner && !isScriptFailed && banner.kind !== 'info' ? banner : null;
}

function createTranscriptHeader(
  runtimeBanner: WorkspaceInitBanner | null,
  initBanner: WorkspaceInitBanner | null,
  actions: Omit<InitStatusBannerProps, 'banner'>
) {
  if (!(runtimeBanner || initBanner)) {
    return undefined;
  }
  return (
    <>
      {runtimeBanner && (
        <InitStatusBanner
          banner={runtimeBanner}
          retryPending={false}
          onRetry={() => undefined}
          onPlay={() => undefined}
        />
      )}
      {initBanner && <InitStatusBanner banner={initBanner} {...actions} />}
    </>
  );
}

export const ChatContent = memo(function ChatContent(props: ChatContentProps) {
  const autoStartPending = props.autoStartPending ?? false;

  const { retry, retryInit } = useRetryWorkspaceInit(props.workspaceId);
  const timeline = useSubagentTimelineMessages(
    props.messages,
    props.sessionId,
    props.connected,
    props.sessionStatus.phase === 'loading'
  );
  const groupedMessages = useGroupedChatMessages(timeline.messages, {
    filterDuplicateResults: true,
  });
  const queuedMessageIds = useMemo(
    () => new Set(props.queuedMessages.map((msg) => msg.id)),
    [props.queuedMessages]
  );
  const { sendMessage } = props;
  const handleCompact = useCallback(
    () => sendMessage('/compact', { preserveInput: true }),
    [sendMessage]
  );

  const running = props.sessionStatus.phase === 'running';
  const promptInFlight = props.sessionRuntime.work?.promptInFlight ?? running;
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
    promptInFlight,
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
          showDismiss: false,
        }
      : null;

  const visibleInitBanner = getVisibleInitBanner(props.initBanner, props.isScriptFailed);

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <ChatTranscript
        thinkingInFooter
        header={createTranscriptHeader(sessionRuntimeBanner, visibleInitBanner, {
          retryPending: retryInit.isPending,
          onRetry: retry,
          onPlay: props.resumeQueuedMessages,
        })}
        workspaceId={props.workspaceId}
        messages={groupedMessages}
        subagentTimelineError={timeline.error}
        acpPlan={props.acpPlan}
        running={running}
        work={props.sessionRuntime.work}
        startingSession={displayStartingState}
        loadingSession={loadingSession}
        latestThinking={props.latestThinking ?? null}
        scroll={props.transcriptScroll}
        queuedMessageIds={queuedMessageIds}
        onRemoveQueuedMessage={props.removeQueuedMessage}
        onSteerQueuedMessage={
          props.connected && promptInFlight && !stopping && !props.isCompacting
            ? props.steerQueuedMessage
            : undefined
        }
        isCompacting={props.isCompacting}
        getUuidForMessageId={props.getUuidForMessageId}
        onRewindToMessage={rewindEnabled ? props.startRewindPreview : undefined}
        resolveWorkspaceFileLink={props.resolveWorkspaceFileLink}
        onWorkspaceFileLink={props.onWorkspaceFileLink}
        onOpenAgents={props.onOpenAgents}
        initBanner={props.initBanner}
      />
      <div className="z-20 flex max-h-full min-h-0 flex-col border-t bg-background pb-safe">
        <PermissionPrompt
          permission={
            props.pendingRequest.type === 'permission' ? props.pendingRequest.request : null
          }
          onApprove={props.approvePermission}
          className="min-h-0 shrink overflow-y-auto"
        />
        <div className="min-h-0 shrink overflow-y-auto">
          <QuestionPrompt
            question={
              props.pendingRequest.type === 'question' ? props.pendingRequest.request : null
            }
            onAnswer={props.answerQuestion}
          />
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <VoiceModeToggle
            sessionId={props.sessionId}
            onFinalTranscript={props.sendMessage}
            running={running}
            disabled={!props.connected || loadingSession}
          />
          <ChatInput
            className="flex-1 min-w-0"
            onSend={props.sendMessage}
            onCompact={handleCompact}
            onStop={props.stopChat}
            disabled={!props.connected || loadingSession}
            running={running}
            promptInFlight={promptInFlight}
            stopping={stopping}
            isCompacting={props.isCompacting}
            inputRef={props.inputRef}
            placeholder={placeholder}
            settings={props.chatSettings}
            capabilities={props.chatCapabilities}
            capabilitiesLoaded={props.chatCapabilitiesLoaded}
            onSettingsChange={props.updateSettings}
            value={props.inputDraft}
            onChange={props.setInputDraft}
            attachments={props.inputAttachments}
            onAttachmentsChange={props.setInputAttachments}
            pendingMessageCount={props.pendingMessages.size}
            slashCommands={props.slashCommands}
            slashCommandsLoaded={props.slashCommandsLoaded}
            tokenStats={props.tokenStats}
            workspaceId={props.workspaceId}
            codexAccountId={props.codexAccountId}
            acpConfigOptions={props.acpConfigOptions}
            onSetConfigOption={props.setConfigOption}
          />
        </div>
      </div>

      <RewindConfirmationDialog
        rewindPreview={props.rewindPreview}
        onConfirm={props.confirmRewind}
        onCancel={props.cancelRewind}
      />
    </div>
  );
});
