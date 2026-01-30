'use client';

import { CheckSquare, Circle, Square } from 'lucide-react';
import { memo } from 'react';
import type { Todo } from '@/components/chat/use-todo-tracker';
import { cn } from '@/lib/utils';

export interface TodoItemProps {
  todo: Todo;
}

/**
 * Renders a single todo item with status icon and text.
 * Shared component used by both TodoPanel and TodoWriteToolRenderer.
 */
export const TodoItem = memo(function TodoItem({ todo }: TodoItemProps) {
  const StatusIcon =
    todo.status === 'completed' ? CheckSquare : todo.status === 'in_progress' ? Circle : Square;

  const statusColor =
    todo.status === 'completed'
      ? 'text-success'
      : todo.status === 'in_progress'
        ? 'text-primary'
        : 'text-muted-foreground';

  return (
    <div className="flex items-start gap-1.5">
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
});
