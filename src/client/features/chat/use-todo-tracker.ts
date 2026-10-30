/** Tracks the current provider task list, with legacy TodoWrite history support. */
import { useMemo } from 'react';
import { z } from 'zod';
import type { ChatMessage, GroupedMessageItem, ToolSequence } from '@/lib/chat-protocol';
import { isToolSequence } from '@/lib/chat-protocol';
import { calculateTodoProgress } from '@/lib/todo-utils';
import type { AcpPlanState } from './reducer';

const todoSchema = z.object({
  content: z.string(),
  activeForm: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'completed']),
});
const todoInputSchema = z.object({ todos: z.array(todoSchema) });

export interface Todo {
  content: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface TodoState {
  todos: Todo[];
  completedCount: number;
  totalCount: number;
  progressPercent: number;
  lastUpdated: string | null;
}

function readTodos(name: string, input: unknown): Todo[] | null {
  if (name !== 'TodoWrite') {
    return null;
  }
  const parsed = todoInputSchema.safeParse(input);
  return parsed.success ? parsed.data.todos : null;
}

function readMessageTodos(message: ChatMessage): Todo[] | null {
  if (message.source !== 'agent' || message.message?.parent_tool_use_id) {
    return null;
  }
  const event = message.message?.event;
  if (event?.type === 'content_block_start' && event.content_block.type === 'tool_use') {
    return readTodos(event.content_block.name, event.content_block.input);
  }
  const content = message.message?.message?.content;
  if (Array.isArray(content)) {
    for (let index = content.length - 1; index >= 0; index--) {
      const block = content[index];
      if (block?.type === 'tool_use') {
        const todos = readTodos(block.name, block.input);
        if (todos !== null) {
          return todos;
        }
      }
    }
  }
  return null;
}

function readToolSequenceTodos(sequence: ToolSequence): Todo[] | null {
  for (let index = sequence.pairedCalls.length - 1; index >= 0; index--) {
    const call = sequence.pairedCalls[index];
    if (!call || call.status === 'error') {
      continue;
    }
    const todos = readTodos(call.name, call.input);
    if (todos !== null) {
      return todos;
    }
  }
  return null;
}

export function useTodoTracker(
  messages: GroupedMessageItem[],
  acpPlan?: AcpPlanState | null
): TodoState {
  return useMemo(() => {
    // ACP updates are complete snapshots; an empty list explicitly clears tasks.
    if (acpPlan) {
      return calculateState(acpPlan.entries, acpPlan.updatedAt);
    }
    return readLatestTodos(messages);
  }, [messages, acpPlan]);
}

function calculateState(todos: Todo[], lastUpdated: string | null): TodoState {
  return { todos, ...calculateTodoProgress(todos), lastUpdated };
}

function readLatestTodos(messages: GroupedMessageItem[]): TodoState {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    const todos = isToolSequence(message)
      ? readToolSequenceTodos(message)
      : readMessageTodos(message);
    if (todos !== null) {
      return calculateState(todos, isToolSequence(message) ? null : message.timestamp);
    }
  }
  return calculateState([], null);
}
