/**
 * Hook to track TodoWrite tool calls across a Claude session.
 * Extracts and maintains the latest todo list state.
 */

import { useMemo } from 'react';
import type { ChatMessage, ClaudeMessage } from '@/lib/claude-types';
import { isToolUseMessage } from '@/lib/claude-types';
import { calculateTodoProgress } from '@/lib/todo-utils';

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
  const { completedCount, totalCount, progressPercent } = calculateTodoProgress(todos);

  return {
    todos,
    completedCount,
    totalCount,
    progressPercent,
    lastUpdated: timestamp,
  };
}

/**
 * Helper to extract todos from a TodoWrite tool use in a stream event
 */
function extractTodosFromStreamEvent(
  claudeMessage: ClaudeMessage,
  timestamp: string
): TodoState | null {
  if (claudeMessage.type !== 'stream_event' || !claudeMessage.event) {
    return null;
  }

  if (claudeMessage.event.type !== 'content_block_start') {
    return null;
  }

  const block = claudeMessage.event.content_block;
  if (block.type === 'tool_use' && block.name === 'TodoWrite') {
    const input = block.input as { todos?: Todo[] };
    const todos = input.todos || [];
    return calculateTodoState(todos, timestamp);
  }

  return null;
}

/**
 * Helper to extract todos from a TodoWrite tool use in an assistant message
 */
function extractTodosFromAssistantMessage(
  claudeMessage: ClaudeMessage,
  timestamp: string
): TodoState | null {
  if (!(claudeMessage.message && Array.isArray(claudeMessage.message.content))) {
    return null;
  }

  for (const item of claudeMessage.message.content) {
    if (item.type === 'tool_use' && item.name === 'TodoWrite') {
      const input = item.input as { todos?: Todo[] };
      const todos = input.todos || [];
      return calculateTodoState(todos, timestamp);
    }
  }

  return null;
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

  // Handle stream_event types - tool info is in event.content_block
  const streamResult = extractTodosFromStreamEvent(claudeMessage, message.timestamp);
  if (streamResult) {
    return streamResult;
  }

  // Handle assistant messages - tool info is in message.content
  return extractTodosFromAssistantMessage(claudeMessage, message.timestamp);
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
