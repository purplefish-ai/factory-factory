import { ArrowDown } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import {
  ChatInput,
  PermissionPrompt,
  QuestionPrompt,
  VirtualizedMessageList,
} from '@/components/chat';
import type { UseChatWebSocketReturn } from '@/components/chat/use-chat-websocket';
import { Button } from '@/components/ui/button';
import { groupAdjacentToolCalls } from '@/lib/chat-protocol';

interface QuickChatContentProps {
  workspaceId: string;
  chatState: UseChatWebSocketReturn;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  isNearBottom: boolean;
  scrollToBottom: () => void;
}

export function QuickChatContent({
  workspaceId,
  chatState,
  viewportRef,
  onScroll,
  isNearBottom,
  scrollToBottom,
}: QuickChatContentProps) {
  const groupedMessages = useMemo(
    () => groupAdjacentToolCalls(chatState.messages),
    [chatState.messages]
  );

  const running = chatState.sessionStatus.phase === 'running';
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
          running={running}
          startingSession={startingSession}
          loadingSession={loadingSession}
          latestThinking={chatState.latestThinking}
          scrollContainerRef={viewportRef}
          onScroll={onScroll}
          messagesEndRef={chatState.messagesEndRef}
          isNearBottom={isNearBottom}
          isCompacting={chatState.isCompacting}
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
            <ArrowDown className="h-4 w-4 mr-1" />
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
          inputRef={chatState.inputRef}
          placeholder={running ? 'Message will be queued...' : 'Type a message...'}
          settings={chatState.chatSettings}
          capabilities={chatState.chatCapabilities}
          onSettingsChange={chatState.updateSettings}
          value={chatState.inputDraft}
          onChange={chatState.setInputDraft}
          onHeightChange={handleHeightChange}
          pendingMessageCount={chatState.pendingMessages.size}
          workspaceId={workspaceId}
          acpConfigOptions={chatState.acpConfigOptions}
          onSetConfigOption={chatState.setConfigOption}
        />
      </div>
    </div>
  );
}
