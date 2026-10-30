import { ArrowDownIcon } from '@phosphor-icons/react/dist/csr/ArrowDown';
import { useCallback, useMemo } from 'react';
import {
  ChatInput,
  PermissionPrompt,
  QuestionPrompt,
  type UseChatWebSocketReturn,
  useGroupedChatMessages,
  VirtualizedMessageList,
} from '@/client/features/chat';
import { useSubagentTimelineMessages } from '@/client/features/subagents';
import { Button } from '@/components/ui/button';

interface QuickChatContentProps {
  workspaceId: string;
  codexAccountId?: string | null;
  chatState: UseChatWebSocketReturn;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  isNearBottom: boolean;
  scrollToBottom: () => void;
}

export function QuickChatContent({
  workspaceId,
  codexAccountId,
  chatState,
  viewportRef,
  onScroll,
  isNearBottom,
  scrollToBottom,
}: QuickChatContentProps) {
  const timeline = useSubagentTimelineMessages(
    chatState.messages,
    chatState.runtimeSessionId,
    chatState.connected,
    chatState.sessionStatus.phase === 'loading'
  );
  const groupedMessages = useGroupedChatMessages(timeline.messages, {
    filterDuplicateResults: true,
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

  const handleHeightChange = useCallback(() => {
    if (isNearBottom && viewportRef.current) {
      viewportRef.current.scrollTo({
        top: viewportRef.current.scrollHeight,
        behavior: 'instant',
      });
    }
  }, [isNearBottom, viewportRef]);

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* Messages area */}
      <div ref={viewportRef} className="flex-1 min-h-0 overflow-y-auto">
        <VirtualizedMessageList
          workspaceId={workspaceId}
          messages={groupedMessages}
          subagentTimelineError={timeline.error}
          acpPlan={chatState.acpPlan}
          running={running}
          work={chatState.sessionRuntime.work}
          startingSession={startingSession}
          loadingSession={loadingSession}
          latestThinking={chatState.latestThinking}
          scrollContainerRef={viewportRef}
          onScroll={onScroll}
          messagesEndRef={chatState.messagesEndRef}
          isNearBottom={isNearBottom}
          isCompacting={chatState.isCompacting}
          queuedMessageIds={queuedMessageIds}
          onRemoveQueuedMessage={chatState.removeQueuedMessage}
        />
      </div>

      {/* Scroll to bottom button */}
      {!isNearBottom && (
        <div className="absolute bottom-32 left-1/2 z-10 -translate-x-1/2">
          <Button
            variant="secondary"
            size="sm"
            onClick={scrollToBottom}
            className="rounded-full shadow-lg"
          >
            <ArrowDownIcon className="h-4 w-4 mr-1" />
            Scroll to bottom
          </Button>
        </div>
      )}

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
          onHeightChange={handleHeightChange}
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
