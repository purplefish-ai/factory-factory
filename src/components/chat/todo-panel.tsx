'use client';

import { CheckCircle, CheckSquare, Circle, ListTodo, Square } from 'lucide-react';
import { memo } from 'react';
import { cn } from '@/lib/utils';
import type { TodoState } from './use-todo-tracker';

export interface TodoPanelProps {
  todoState: TodoState;
}

/**
 * Displays a compact todo panel showing the current task list state.
 * Can be placed in the chat sidebar or as a floating panel.
 */
export const TodoPanel = memo(function TodoPanel({ todoState }: TodoPanelProps) {
  const { todos, completedCount, totalCount, progressPercent } = todoState;

  // Don't render if there are no todos
  if (todos.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border bg-card text-card-foreground shadow-sm">
      <div className="p-3 space-y-2">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ListTodo className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Tasks</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {completedCount}/{totalCount}
            </span>
            <div className="flex items-center gap-0.5">
              <CheckCircle className="h-3 w-3 text-success" />
              <span className="text-xs font-medium">{progressPercent}%</span>
            </div>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        {/* Todo List */}
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {todos.map((todo, index) => {
            const StatusIcon =
              todo.status === 'completed'
                ? CheckSquare
                : todo.status === 'in_progress'
                  ? Circle
                  : Square;

            const statusColor =
              todo.status === 'completed'
                ? 'text-success'
                : todo.status === 'in_progress'
                  ? 'text-primary'
                  : 'text-muted-foreground';

            return (
              <div key={`${todo.content}-${index}`} className="flex items-start gap-1.5">
                <StatusIcon className={cn('h-3.5 w-3.5 shrink-0 mt-0.5', statusColor)} />
                <div className="flex-1 min-w-0">
                  <div
                    className={cn(
                      'text-xs',
                      todo.status === 'completed' && 'line-through text-muted-foreground'
                    )}
                  >
                    {todo.status === 'in_progress' ? todo.activeForm : todo.content}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
