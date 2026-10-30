import { useMemo } from 'react';
import {
  ChatInput,
  PermissionPrompt,
  QuestionPrompt,
  type UseChatWebSocketReturn,
  useGroupedChatMessages,
  ChatTranscript,
  type TranscriptScrollOptions,
} from '@/client/features/chat';

interface QuickChatContentProps {
  workspaceId: string;
  codexAccountId?: string | null;
  chatState: UseChatWebSocketReturn;
  transcriptScroll: TranscriptScrollOptions;
}

export function QuickChatContent({
  workspaceId,
  codexAccountId,
  chatState,
  transcriptScroll,
}: QuickChatContentProps) {
  const groupedMessages = useGroupedChatMessages(chatState.messages);
  const queuedMessageIds = useMemo(
    () => new Set(chatState.queuedMessages.map((message) => message.id)),
    [chatState.queuedMessages]
  );

  const running = chatState.sessionStatus.phase === 'running';
  const promptInFlight = chatState.sessionRuntime.work?.promptInFlight ?? running;
  const stopping = chatState.sessionStatus.phase === 'stopping';
  const loadingSession = chatState.sessionStatus.phase === 'loading';
  const startingSession = chatState.sessionStatus.phase === 'starting';

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* Messages area */}
      <ChatTranscript
        workspaceId={workspaceId}
        messages={groupedMessages}
        acpPlan={chatState.acpPlan}
        running={running}
        work={chatState.sessionRuntime.work}
        startingSession={startingSession}
        loadingSession={loadingSession}
        latestThinking={chatState.latestThinking}
        scroll={transcriptScroll}
        isCompacting={chatState.isCompacting}
        queuedMessageIds={queuedMessageIds}
        onRemoveQueuedMessage={chatState.removeQueuedMessage}
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
          onSend={chatState.sendMessage}
          onStop={chatState.stopChat}
          disabled={!chatState.connected || loadingSession}
          running={running}
          stopping={stopping}
          promptInFlight={promptInFlight}
          inputRef={chatState.inputRef}
          placeholder={promptInFlight ? 'Message will be queued...' : 'Type a message...'}
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
        />
      </div>
    </div>
  );
}
