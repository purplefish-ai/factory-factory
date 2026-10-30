import { memo } from 'react';
import { TodoItem } from '@/client/components/todo-item';
import { withOccurrenceKeys } from '@/client/lib/list-keys';
import type { TodoState } from './use-todo-tracker';

export interface TodoPanelProps {
  todoState: TodoState;
}

/** The latest task snapshot, displayed inline at the end of the conversation. */
export const TodoPanel = memo(function TodoPanel({ todoState }: TodoPanelProps) {
  if (todoState.todos.length === 0) {
    return null;
  }
  return (
    <ul aria-label="Tasks" className="my-4 space-y-2 rounded-xl border border-border/60 p-4">
      {withOccurrenceKeys(todoState.todos, (todo) => todo.content).map(({ item: todo, key }) => (
        <li key={key}>
          <TodoItem todo={todo} />
        </li>
      ))}
    </ul>
  );
});
