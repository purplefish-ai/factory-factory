'use client';

import { Suspense, useCallback } from 'react';
import { GroupedMessages, useChatWebSocket } from '@/components/chat';

function ChatContent() {
  const {
    messages,
    input,
    setInput,
    connected,
    running,
    claudeSessionId,
    availableSessions,
    showSessionPicker,
    setShowSessionPicker,
    sendMessage,
    clearChat,
    loadSession,
    inputRef,
    messagesEndRef,
  } = useChatWebSocket();

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage]
  );

  return (
    <div className="flex flex-col h-[calc(100vh-2rem)]">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Chat with Claude</h1>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div
              className={`w-2 h-2 rounded-full ${
                connected
                  ? running
                    ? 'bg-yellow-500 animate-pulse'
                    : 'bg-green-500'
                  : 'bg-red-500'
              }`}
            />
            <span>{connected ? (running ? 'Processing...' : 'Connected') : 'Disconnected'}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowSessionPicker(!showSessionPicker)}
              className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground border rounded-md hover:bg-muted"
            >
              Load Session ({availableSessions.length})
            </button>
            {showSessionPicker && availableSessions.length > 0 && (
              <div className="absolute right-0 mt-1 w-80 max-h-96 overflow-y-auto bg-background border rounded-lg shadow-lg z-50">
                <div className="p-2 border-b text-xs text-muted-foreground font-medium">
                  Previous Sessions
                </div>
                {availableSessions.map((sid) => (
                  <button
                    key={sid}
                    type="button"
                    onClick={() => loadSession(sid)}
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-muted truncate ${
                      sid === claudeSessionId ? 'bg-primary/10 text-primary' : ''
                    }`}
                  >
                    {sid}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={clearChat}
            className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground border rounded-md hover:bg-muted"
          >
            New Chat
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <div className="text-lg mb-2">Start a conversation</div>
            <div className="text-sm">Type a message below to chat with Claude</div>
          </div>
        ) : (
          <GroupedMessages messages={messages} />
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 border-t">
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              connected
                ? 'Type your message... (Enter to send, Shift+Enter for new line)'
                : 'Connecting...'
            }
            disabled={!connected}
            className="flex-1 min-h-[80px] max-h-[200px] px-4 py-3 border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:bg-muted disabled:cursor-not-allowed"
            rows={3}
          />
          <button
            type="button"
            onClick={sendMessage}
            disabled={!(connected && input.trim())}
            className="px-6 py-3 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed self-end"
          >
            Send
          </button>
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          Claude CLI JSON Streaming POC
          {claudeSessionId && (
            <span className="ml-2">| Claude Session: {claudeSessionId.slice(0, 8)}...</span>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatLoading() {
  return (
    <div className="flex flex-col h-[calc(100vh-2rem)] items-center justify-center">
      <div className="text-muted-foreground">Loading chat...</div>
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense fallback={<ChatLoading />}>
      <ChatContent />
    </Suspense>
  );
}
