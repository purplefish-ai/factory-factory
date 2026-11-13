// @vitest-environment jsdom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ToolSequence } from '@/lib/chat-protocol';
import { createUserMessage } from '@/lib/claude.fixture';
import { TranscriptRenderingFixture } from './transcript-rendering.test-harness';

vi.mock('./agent-activity/tool-renderers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-activity/tool-renderers')>();
  return {
    ...actual,
    ToolSequenceGroup: ({ sequence }: { sequence: ToolSequence }) => {
      if (sequence.id === 'broken-sequence') {
        throw new TypeError('todos.filter is not a function');
      }
      return <p>{sequence.id}</p>;
    },
  };
});

const brokenSequence: ToolSequence = {
  type: 'tool_sequence',
  id: 'broken-sequence',
  pairedCalls: [
    { id: 'call-1', name: 'TodoWrite', input: { todos: 'not a list' }, status: 'success' },
  ],
};

beforeEach(() => {
  vi.stubGlobal('reportError', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('contains a row that throws while rendering and keeps its siblings', () => {
  const container = document.createElement('div');
  const root = createRoot(container, { onCaughtError: () => undefined });
  try {
    flushSync(() =>
      root.render(
        <TranscriptRenderingFixture
          messages={[
            createUserMessage('Message before', 0),
            brokenSequence,
            createUserMessage('Message after', 2),
          ]}
          running={false}
          startingSession={false}
          loadingSession={false}
        />
      )
    );

    const alerts = container.querySelectorAll('[role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain("Couldn't render this message");
    expect(alerts[0]?.textContent).toContain('todos.filter is not a function');
    expect(container.textContent).toContain('Message before');
    expect(container.textContent).toContain('Message after');
    expect(globalThis.reportError).toHaveBeenCalledOnce();
  } finally {
    flushSync(() => root.unmount());
  }
});
