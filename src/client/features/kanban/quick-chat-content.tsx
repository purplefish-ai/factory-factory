import { useMemo } from 'react';
import {
  ChatInput,
  getChatPendingRequestType,
  PermissionPrompt,
  QuestionPrompt,
  type UseChatWebSocketReturn,
  useGroupedChatMessages,
  useTranscriptSend,
  ChatTranscript,
  type TranscriptScrollOptions,
} from '@/client/features/chat';
import { getLiveSessionControlId } from '@/client/features/session-controls';
import { useSubagentTimelineMessages } from '@/client/features/subagents';
import { getPendingRequestPresentation } from '@/client/lib/pending-request-presentation';

interface QuickChatContentProps {
  workspaceId: string;
  codexAccountId?: string | null;
  chatState: UseChatWebSocketReturn;
  transcriptScroll: TranscriptScrollOptions;
  onRunQuickActionInNewChat?: (name: string, prompt: string) => void;
  newChatUnavailableReason?: string | null;
}

export function QuickChatContent({
  workspaceId,
  codexAccountId,
  chatState,
  transcriptScroll,
  onRunQuickActionInNewChat,
  newChatUnavailableReason,
}: QuickChatContentProps) {
  const { sendMessage, transcriptScroll: scroll } = useTranscriptSend(
    chatState.sendMessage,
    transcriptScroll
  );
  const timeline = useSubagentTimelineMessages(
    chatState.messages,
    chatState.runtimeSessionId,
    chatState.connected,
    chatState.sessionStatus.phase === 'loading'
  );
  const groupedMessages = useGroupedChatMessages(timeline.messages, {
    filterDuplicateResults: true,
    groupBoundaries: chatState.transcriptPageBoundaries,
  });
  const queuedMessageIds = useMemo(
    () => new Set(chatState.queuedMessages.map((message) => message.id)),
    [chatState.queuedMessages]
  );

  const running = chatState.sessionStatus.phase === 'running';
  const promptInFlight = chatState.sessionRuntime.work?.promptInFlight ?? running;
  const stopping = chatState.sessionStatus.phase === 'stopping';
  const loadingSession = chatState.sessionStatus.phase === 'loading';
  const startingSession = chatState.sessionStatus.phase === 'starting';
  const pendingRequestType = getChatPendingRequestType(
    chatState.pendingRequest,
    chatState.sessionRuntime
  );
  let placeholder = promptInFlight ? 'Message will be queued…' : 'Type a message…';
  if (stopping) {
    placeholder = 'Stopping…';
  } else if (pendingRequestType && running) {
    placeholder = getPendingRequestPresentation(pendingRequestType).composerPlaceholder;
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* Messages area */}
      <ChatTranscript
        sessionId={chatState.runtimeSessionId}
        thinkingInFooter
        pendingRequestType={running ? pendingRequestType : null}
        workspaceId={workspaceId}
        messages={groupedMessages}
        history={chatState.transcriptHistory}
        subagentTimelineError={timeline.error}
        runningSubagentIconIndices={timeline.runningSubagentIconIndices}
        acpPlan={chatState.acpPlan}
        running={running}
        work={chatState.sessionRuntime.work}
        controlSessionId={getLiveSessionControlId(
          chatState.runtimeSessionId,
          chatState.connected && chatState.controlsHydrated,
          chatState.sessionRuntime
        )}
        startingSession={startingSession}
        loadingSession={loadingSession}
        latestThinking={chatState.latestThinking}
        scroll={scroll}
        isCompacting={chatState.isCompacting}
        queuedMessageIds={queuedMessageIds}
        onRemoveQueuedMessage={chatState.removeQueuedMessage}
        onSteerQueuedMessage={
          chatState.connected && promptInFlight && !stopping && !chatState.isCompacting
            ? chatState.steerQueuedMessage
            : undefined
        }
      />
      {/* Prompts + input area */}
      <div className="z-20 border-t bg-background pb-safe">
        <PermissionPrompt
          permission={
            chatState.pendingRequest.type === 'permission' ? chatState.pendingRequest.request : null
          }
          onApprove={chatState.approvePermission}
        />
        <QuestionPrompt
          question={
            chatState.pendingRequest.type === 'question' ? chatState.pendingRequest.request : null
          }
          onAnswer={chatState.answerQuestion}
        />
        <ChatInput
          onSend={sendMessage}
          onStop={chatState.stopChat}
          disabled={!chatState.connected || loadingSession}
          running={running}
          stopping={stopping}
          promptInFlight={promptInFlight}
          inputRef={chatState.inputRef}
          placeholder={placeholder}
          settings={chatState.chatSettings}
          capabilities={chatState.chatCapabilities}
          capabilitiesLoaded={chatState.chatCapabilitiesLoaded}
          onSettingsChange={chatState.updateSettings}
          slashCommands={chatState.slashCommands}
          slashCommandsLoaded={chatState.slashCommandsLoaded}
          value={chatState.inputDraft}
          onChange={chatState.setInputDraft}
          attachments={chatState.inputAttachments}
          onAttachmentsChange={chatState.setInputAttachments}
          pendingMessageCount={chatState.pendingMessages.size}
          workspaceId={workspaceId}
          codexAccountId={codexAccountId}
          acpConfigOptions={chatState.acpConfigOptions}
          onSetConfigOption={chatState.setConfigOption}
          onRunQuickActionInNewChat={onRunQuickActionInNewChat}
          newChatUnavailableReason={newChatUnavailableReason}
        />
      </div>
    </div>
  );
}
