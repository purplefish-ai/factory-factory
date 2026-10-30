import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { memo } from 'react';
import type { Todo } from '@/client/features/chat/use-todo-tracker';
import { cn } from '@/lib/utils';

export interface TodoItemProps {
  todo: Todo;
}

/** Circular task status indicators shared by inline tasks and legacy tool details. */
export const TodoItem = memo(function TodoItem({ todo }: TodoItemProps) {
  const completed = todo.status === 'completed';
  const active = todo.status === 'in_progress';
  const label = completed ? 'Completed' : active ? 'In progress' : 'Pending';
  return (
    <div className="flex items-start gap-2.5 text-sm">
      <span role="img" aria-label={label} className="mt-0.5 shrink-0 text-muted-foreground">
        {completed ? (
          <CheckCircleIcon weight="fill" className="h-4 w-4" />
        ) : (
          <span
            className={cn(
              'block h-4 w-4 rounded-full border-2',
              active
                ? 'border-primary/40 border-t-primary animate-spin motion-reduce:animate-none'
                : 'border-dashed border-muted-foreground/60'
            )}
          />
        )}
      </span>
      <span
        className={cn(
          'min-w-0 break-words [overflow-wrap:anywhere]',
          completed && 'text-muted-foreground'
        )}
      >
        {active ? todo.activeForm || todo.content : todo.content}
      </span>
    </div>
  );
});
