// @vitest-environment jsdom
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { dispatchSubagentChange } from '@/client/lib/subagent-events';
import type { ChatMessage } from '@/lib/chat-protocol';
import { useSubagentTimelineMessages } from './use-subagent-timeline-messages';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  invalidate: vi.fn(() => Promise.resolve()),
  next: vi.fn(() => Promise.resolve()),
  pages: [] as unknown[],
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ session: { listSubagents: { invalidate: mocks.invalidate } } }),
    session: {
      listSubagents: {
        useInfiniteQuery: (...args: unknown[]) => {
          mocks.query(...args);
          return {
            data: { pages: mocks.pages },
            hasNextPage: false,
            isFetching: false,
            error: null,
            fetchNextPage: mocks.next,
          };
        },
      },
    },
  },
}));
afterEach(() => {
  vi.clearAllMocks();
  mocks.pages = [];
});

const EMPTY_MESSAGES: ChatMessage[] = [];
let projectedMessages: ChatMessage[] = [];
function Harness({
  sessionId,
  enabled,
  rawMessages = EMPTY_MESSAGES,
}: {
  sessionId: string | null;
  enabled: boolean;
  rawMessages?: ChatMessage[];
}) {
  const messages = useSubagentTimelineMessages(rawMessages, sessionId, enabled);
  projectedMessages = messages;
  return createElement('div', null, messages.map((item) => item.text).join(','));
}

it('projects all pages, refreshes the selected session, and clears events on a session switch', () => {
  const subagent = {
    id: 'a',
    name: 'Review',
    status: 'running',
    createdAt: '2026-10-30T12:00:00Z',
    completedAt: null,
    updatedAt: null,
    latestActivity: null,
    resultPreview: null,
  };
  mocks.pages = [
    { supported: true, subagents: [subagent] },
    { supported: true, subagents: [{ ...subagent, id: 'b', name: 'Build' }] },
  ];
  const container = document.createElement('div');
  const root = createRoot(container);

  flushSync(() => root.render(createElement(Harness, { sessionId: 'parent', enabled: true })));
  expect(container.textContent).toBe('Review started working,Build started working');
  dispatchSubagentChange({ sessionId: 'other', subagentId: 'a', change: 'updated' });
  expect(mocks.invalidate).not.toHaveBeenCalled();
  dispatchSubagentChange({ sessionId: 'parent', subagentId: 'a', change: 'completed' });
  expect(mocks.invalidate).toHaveBeenCalledWith({ sessionId: 'parent', cursor: null, limit: 100 });
  mocks.pages = [];
  flushSync(() => root.render(createElement(Harness, { sessionId: 'next', enabled: false })));
  expect(container.textContent).toBe('');
  expect(mocks.query.mock.lastCall?.[1]).toMatchObject({ enabled: false });
  root.unmount();
});

it('keeps lifecycle row objects stable while new text streams into the transcript', () => {
  mocks.pages = [
    {
      supported: true,
      subagents: [
        {
          id: 'a',
          name: 'Review',
          status: 'running',
          createdAt: '2026-10-30T12:00:00Z',
          completedAt: null,
          updatedAt: null,
          latestActivity: null,
          resultPreview: null,
        },
      ],
    },
  ];
  const container = document.createElement('div');
  const root = createRoot(container);
  flushSync(() => root.render(createElement(Harness, { sessionId: 'parent', enabled: true })));
  const event = projectedMessages[0];
  const message: ChatMessage = {
    id: 'text',
    source: 'agent',
    order: 1,
    timestamp: '2026-10-30T12:00:01Z',
    message: { type: 'assistant', message: { role: 'assistant', content: 'Working' } },
  };
  flushSync(() =>
    root.render(
      createElement(Harness, { sessionId: 'parent', enabled: true, rawMessages: [message] })
    )
  );
  expect(projectedMessages[0]).toBe(event);
  expect(projectedMessages[1]).toBe(message);
  root.unmount();
});
