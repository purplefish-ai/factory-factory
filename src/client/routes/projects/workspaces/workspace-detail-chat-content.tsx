import { ArrowDown } from 'lucide-react';
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
import type { CommandInfo, TokenStats } from '@/lib/claude-types';
import { groupAdjacentToolCalls, isToolSequence } from '@/lib/claude-types';

interface ChatContentProps {
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
  updateSettings: ReturnType<typeof useChatWebSocket>['updateSettings'];
  inputDraft: ReturnType<typeof useChatWebSocket>['inputDraft'];
  setInputDraft: ReturnType<typeof useChatWebSocket>['setInputDraft'];
  inputAttachments: ReturnType<typeof useChatWebSocket>['inputAttachments'];
  setInputAttachments: ReturnType<typeof useChatWebSocket>['setInputAttachments'];
  queuedMessages: ReturnType<typeof useChatWebSocket>['queuedMessages'];
  removeQueuedMessage: ReturnType<typeof useChatWebSocket>['removeQueuedMessage'];
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
}

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
  updateSettings,
  inputDraft,
  setInputDraft,
  inputAttachments,
  setInputAttachments,
  queuedMessages,
  removeQueuedMessage,
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
}: ChatContentProps) {
  const groupedMessages = useMemo(() => groupAdjacentToolCalls(messages), [messages]);
  const latestToolSequence = useMemo(() => {
    for (let i = groupedMessages.length - 1; i >= 0; i -= 1) {
      const item = groupedMessages[i];
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
  const startingSession = sessionStatus.phase === 'starting';
  const loadingSession = sessionStatus.phase === 'loading';

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

  const placeholder = (() => {
    if (stopping) {
      return 'Stopping...';
    }
    if (
      pendingRequest.type === 'permission' &&
      pendingRequest.request.toolName === 'ExitPlanMode'
    ) {
      return 'Type feedback to revise the plan...';
    }
    if (running) {
      return 'Message will be queued...';
    }
    return 'Type a message...';
  })();

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div ref={viewportRef} className="flex-1 min-h-0 overflow-y-auto">
        <VirtualizedMessageList
          messages={groupedMessages}
          running={running}
          startingSession={startingSession}
          loadingSession={loadingSession}
          scrollContainerRef={viewportRef}
          onScroll={onScroll}
          messagesEndRef={messagesEndRef}
          isNearBottom={isNearBottom}
          queuedMessageIds={queuedMessageIds}
          onRemoveQueuedMessage={removeQueuedMessage}
          isCompacting={isCompacting}
          getUuidForMessageId={getUuidForMessageId}
          onRewindToMessage={startRewindPreview}
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
          starting={startingSession}
          stopping={stopping}
          permissionMode={permissionMode}
          latestThinking={latestThinking ?? null}
          latestToolSequence={latestToolSequence}
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
          disabled={!connected}
          running={running}
          stopping={stopping}
          inputRef={inputRef}
          placeholder={placeholder}
          settings={chatSettings}
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
