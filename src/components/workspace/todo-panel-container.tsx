'use client';

import { memo } from 'react';
import { TodoPanel } from '@/components/chat/todo-panel';
import { useChatWebSocket } from '@/components/chat/use-chat-websocket';
import { useTodoTracker } from '@/components/chat/use-todo-tracker';

export interface TodoPanelContainerProps {
  workspaceId: string;
}

/**
 * Container component that connects the TodoPanel to the chat messages
 * from the active Claude session in the workspace.
 */
export const TodoPanelContainer = memo(function TodoPanelContainer({
  workspaceId: _workspaceId,
}: TodoPanelContainerProps) {
  // Get messages from the active chat session
  const { messages } = useChatWebSocket();

  // Track todos from messages
  const todoState = useTodoTracker(messages);

  // If there are no todos, show a helpful message
  if (todoState.todos.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="text-center text-sm text-muted-foreground">
          <p className="mb-2">No tasks tracked yet</p>
          <p className="text-xs">Tasks will appear here when Claude uses the TodoWrite tool</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-3">
      <TodoPanel todoState={todoState} />
    </div>
  );
});
