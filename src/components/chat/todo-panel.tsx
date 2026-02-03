import { CheckCircle, ListTodo } from 'lucide-react';
import { memo } from 'react';
import { TodoItem } from '@/components/shared';
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
          {todos.map((todo, index) => (
            <TodoItem key={`${todo.content}-${index}`} todo={todo} />
          ))}
        </div>
      </div>
    </div>
  );
});
