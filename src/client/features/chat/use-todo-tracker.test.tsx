// @vitest-environment jsdom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { GroupedMessageItem } from '@/lib/chat-protocol';
import type { AcpPlanState } from './reducer';
import { type TodoState, useTodoTracker } from './use-todo-tracker';

function Probe({
  messages,
  plan,
  onState,
}: {
  messages: GroupedMessageItem[];
  plan?: AcpPlanState | null;
  onState: (state: TodoState) => void;
}) {
  onState(useTodoTracker(messages, plan));
  return null;
}

describe('task tracking', () => {
  it('reads validated legacy tool groups and lets an empty ACP list clear them', () => {
    const messages: GroupedMessageItem[] = [
      {
        type: 'tool_sequence',
        id: 'tools',
        pairedCalls: [
          {
            id: 'todo',
            name: 'TodoWrite',
            status: 'success',
            input: {
              todos: [
                {
                  content: 'Legacy task',
                  activeForm: 'Working on legacy task',
                  status: 'in_progress',
                },
              ],
            },
          },
          {
            id: 'malformed',
            name: 'TodoWrite',
            status: 'pending',
            input: { todos: [{ content: {} }] },
          },
        ],
      },
    ];
    let state: TodoState | undefined;
    const onState = (next: TodoState) => {
      state = next;
    };
    const root = createRoot(document.createElement('div'));
    try {
      flushSync(() => root.render(<Probe messages={messages} onState={onState} />));
      expect(state?.todos).toEqual([
        { content: 'Legacy task', activeForm: 'Working on legacy task', status: 'in_progress' },
      ]);
      flushSync(() =>
        root.render(
          <Probe messages={messages} onState={onState} plan={{ entries: [], updatedAt: 'now' }} />
        )
      );
      expect(state?.todos).toEqual([]);
      flushSync(() => root.render(<Probe messages={messages} onState={onState} plan={null} />));
      expect(state?.todos).toHaveLength(1);
    } finally {
      flushSync(() => root.unmount());
    }
  });
});
