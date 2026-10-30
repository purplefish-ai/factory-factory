// @vitest-environment jsdom
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { dispatchSubagentChange } from '@/client/lib/subagent-events';
import type { ChatMessage } from '@/lib/chat-protocol';
import type { getNextSubagentPageParam } from './subagent-pagination';
import type { SubagentListItem, SubagentListResult } from './types';
import { useSubagentTimelineMessages } from './use-subagent-timeline-messages';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  invalidate: vi.fn(() => Promise.resolve()),
  next: vi.fn(() => Promise.resolve()),
  refetch: vi.fn(() => Promise.resolve()),
  pagesBySession: new Map<string, SubagentListResult[]>(),
  pageParams: [null] as unknown[],
  error: null as Error | null,
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ session: { listSubagents: { invalidate: mocks.invalidate } } }),
    session: {
      listSubagents: {
        useInfiniteQuery: (
          input: { sessionId: string },
          options: { getNextPageParam: typeof getNextSubagentPageParam }
        ) => {
          mocks.query(input, options);
          const pages = mocks.pagesBySession.get(input.sessionId) ?? [];
          const lastPage = pages.at(-1);
          const nextPage = lastPage
            ? options.getNextPageParam(lastPage, pages, mocks.pageParams.at(-1), mocks.pageParams)
            : undefined;
          return {
            data: {
              pages,
              pageParams: mocks.pageParams,
            },
            hasNextPage: nextPage !== undefined,
            isFetching: false,
            error: mocks.error,
            fetchNextPage: mocks.next,
            refetch: mocks.refetch,
          };
        },
      },
    },
  },
}));
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    flushSync(() => root.unmount());
  }
  vi.clearAllMocks();
  mocks.pagesBySession.clear();
  mocks.pageParams = [null];
  mocks.error = null;
});

const agent: SubagentListItem = {
  id: 'a',
  name: 'Review',
  status: 'running',
  createdAt: '2026-10-30T12:00:00Z',
  completedAt: null,
  updatedAt: null,
  latestActivity: null,
  resultPreview: null,
};
const EMPTY_MESSAGES: ChatMessage[] = [];
let projectedMessages: ChatMessage[] = [];
let timelineError: { message: string; onRetry: () => void } | null = null;
type HarnessProps = { sessionId: string | null; enabled: boolean; rawMessages?: ChatMessage[] };
function Harness({ sessionId, enabled, rawMessages = EMPTY_MESSAGES }: HarnessProps) {
  const { messages, error } = useSubagentTimelineMessages(rawMessages, sessionId, enabled);
  timelineError = error;
  projectedMessages = messages;
  return createElement('div', null, messages.map((item) => item.text).join(','));
}
function createHarness(props: HarnessProps) {
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  const render = (next: HarnessProps) => flushSync(() => root.render(createElement(Harness, next)));
  render(props);
  return { container, render };
}

it('projects all pages, refreshes the selected session, and switches independently of cached parent data', () => {
  const pages: SubagentListResult[] = [
    { supported: true, subagents: [agent], nextCursor: 'page-2' },
    { supported: true, subagents: [{ ...agent, id: 'b', name: 'Build' }], nextCursor: null },
  ];
  mocks.pagesBySession.set('parent', pages);
  const harness = createHarness({ sessionId: 'parent', enabled: true });
  expect(harness.container.textContent).toBe('Review started working,Build started working');
  dispatchSubagentChange({ sessionId: 'other', subagentId: 'a', change: 'updated' });
  expect(mocks.invalidate).not.toHaveBeenCalled();
  dispatchSubagentChange({ sessionId: 'parent', subagentId: 'a', change: 'completed' });
  expect(mocks.invalidate).toHaveBeenCalledWith({ sessionId: 'parent' });

  harness.render({ sessionId: 'next', enabled: true });
  expect(harness.container.textContent).toBe('');
  expect(mocks.pagesBySession.get('parent')).toBe(pages);
  expect(mocks.query.mock.lastCall?.[0]).toMatchObject({ sessionId: 'next' });
  harness.render({ sessionId: 'parent', enabled: true });
  expect(harness.container.textContent).toBe('Review started working,Build started working');
});

it('keeps lifecycle row objects stable while new text streams into the transcript', () => {
  mocks.pagesBySession.set('parent', [{ supported: true, subagents: [agent], nextCursor: null }]);
  const harness = createHarness({ sessionId: 'parent', enabled: true });
  const event = projectedMessages[0];
  const message: ChatMessage = {
    id: 'text',
    source: 'agent',
    order: 1,
    timestamp: '2026-10-30T12:00:01Z',
    message: { type: 'assistant', message: { role: 'assistant', content: 'Working' } },
  };
  harness.render({ sessionId: 'parent', enabled: true, rawMessages: [message] });
  expect(projectedMessages[0]).toBe(event);
  expect(projectedMessages[1]).toBe(message);
});

it('keeps known lifecycle rows and offers recovery when the provider repeats a page cursor', () => {
  mocks.pagesBySession.set('parent', [
    { supported: true, subagents: [agent], nextCursor: 'repeat' },
    { supported: true, subagents: [], nextCursor: 'repeat' },
  ]);
  mocks.pageParams = [null, 'repeat'];
  const harness = createHarness({ sessionId: 'parent', enabled: true });
  expect(harness.container.textContent).toBe('Review started working');
  expect(timelineError?.message).toBe('Some sub-agent activity could not be loaded.');
  timelineError?.onRetry();
  expect(mocks.refetch).toHaveBeenCalledOnce();
  expect(mocks.next).not.toHaveBeenCalled();
});

it('offers the same recovery after a page request fails without discarding loaded rows', () => {
  mocks.pagesBySession.set('parent', [
    { supported: true, subagents: [agent], nextCursor: 'page-2' },
  ]);
  mocks.error = new Error('Request failed');
  const harness = createHarness({ sessionId: 'parent', enabled: true });
  expect(harness.container.textContent).toBe('Review started working');
  expect(timelineError?.message).toBe('Some sub-agent activity could not be loaded.');
  timelineError?.onRetry();
  expect(mocks.refetch).toHaveBeenCalledOnce();
  expect(mocks.next).not.toHaveBeenCalled();
});

it('automatically loads the next provider page and stops at the end of the list', () => {
  mocks.pagesBySession.set('parent', [{ supported: true, subagents: [agent], nextCursor: 'next' }]);
  const harness = createHarness({ sessionId: 'parent', enabled: true });
  expect(mocks.next).toHaveBeenCalledOnce();
  mocks.pagesBySession.set('parent', [
    { supported: true, subagents: [agent], nextCursor: 'next' },
    { supported: true, subagents: [{ ...agent, id: 'b', name: 'Build' }], nextCursor: null },
  ]);
  mocks.pageParams = [null, 'next'];
  harness.render({ sessionId: 'parent', enabled: true });
  expect(harness.container.textContent).toBe('Review started working,Build started working');
  expect(mocks.next).toHaveBeenCalledOnce();
  expect(timelineError).toBeNull();
});
