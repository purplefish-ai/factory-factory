/**
 * Hook to track TodoWrite tool calls across a Claude session.
 * Extracts and maintains the latest todo list state.
 */

import { useMemo } from 'react';
import type { ChatMessage } from '@/lib/claude-types';
import { isToolUseMessage } from '@/lib/claude-types';

export interface Todo {
  content: string;
  activeForm: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface TodoState {
  todos: Todo[];
  completedCount: number;
  totalCount: number;
  progressPercent: number;
  lastUpdated: string | null;
}

/**
 * Helper to calculate todo state from a todo list
 */
function calculateTodoState(todos: Todo[], timestamp: string): TodoState {
  const completedCount = todos.filter((t) => t.status === 'completed').length;
  const totalCount = todos.length;
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  return {
    todos,
    completedCount,
    totalCount,
    progressPercent,
    lastUpdated: timestamp,
  };
}

/**
 * Helper to extract todos from a TodoWrite tool call
 */
function extractTodosFromMessage(message: ChatMessage): TodoState | null {
  if (message.source !== 'claude' || !message.message) {
    return null;
  }

  const claudeMessage = message.message;
  if (!isToolUseMessage(claudeMessage)) {
    return null;
  }

  // Check if this message contains a TodoWrite tool call
  // claudeMessage.message.content is the actual content array
  const messageContent = claudeMessage.message;
  if (!messageContent || typeof messageContent.content === 'string') {
    return null;
  }

  const content = messageContent.content;
  for (const item of content) {
    if (item.type === 'tool_use' && item.name === 'TodoWrite') {
      const input = item.input as { todos?: Todo[] };
      const todos = input.todos || [];
      return calculateTodoState(todos, message.timestamp);
    }
  }

  return null;
}

/**
 * Extracts the latest todo list from chat messages.
 * Finds the most recent TodoWrite tool call and returns its todos.
 */
export function useTodoTracker(messages: ChatMessage[]): TodoState {
  return useMemo(() => {
    // Find the most recent TodoWrite tool call by scanning messages in reverse
    for (let i = messages.length - 1; i >= 0; i--) {
      const todoState = extractTodosFromMessage(messages[i]);
      if (todoState) {
        return todoState;
      }
    }

    // No todos found
    return {
      todos: [],
      completedCount: 0,
      totalCount: 0,
      progressPercent: 0,
      lastUpdated: null,
    };
  }, [messages]);
}
