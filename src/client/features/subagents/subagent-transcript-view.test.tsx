// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchSubagentChange } from '@/client/lib/subagent-events';
import type { ChatMessage } from '@/lib/chat-protocol';
import { SubagentTranscriptContent } from './subagent-transcript-content';
import { SubagentTranscriptView } from './subagent-transcript-view';
import type { SubagentSelection } from './types';

const mocks = vi.hoisted(() => ({
  fetchNextPage: vi.fn(() => Promise.resolve({ isFetchNextPageError: false })),
  refetch: vi.fn(() => Promise.resolve()),
  useInfiniteQuery: vi.fn(),
  projectAcpTranscriptUpdates: vi.fn(
    (
      updates: Array<{
        sessionUpdate: string;
        content?: { type?: string; text?: string };
      }>
    ): ChatMessage[] =>
      updates.flatMap((update, index) =>
        update.sessionUpdate === 'user_message_chunk' && update.content?.type === 'text'
          ? [
              {
                id: `projected-${update.content.text}-${index}`,
                source: 'user' as const,
                text: update.content.text ?? '',
                timestamp: '1970-01-01T00:00:00.000Z',
                order: index,
              },
            ]
          : []
      )
  ),
  queryResult: {
    data: undefined as
      | undefined
      | {
          pages: Array<{
            projectionBoundary: 'turn';
            updates: Array<{
              sessionUpdate: 'user_message_chunk';
              content: { type: 'text'; text: string };
            }>;
            nextCursor: string | null;
          }>;
        },
    error: null as Error | null,
    isLoading: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    isRefetchError: false,
    hasNextPage: false,
  },
}));

vi.mock('@/client/features/chat', async () => {
  const { createElement: createMockElement } =
    await vi.importActual<typeof import('react')>('react');
  const renderItem = (item: { id: string; text?: string }) =>
    createMockElement('div', { key: item.id, 'data-message-id': item.id }, item.text ?? item.id);
  return {
    GroupedMessageItemRenderer: ({ item }: { item: { id: string; text?: string } }) =>
      renderItem(item),
    projectAcpTranscriptUpdates: mocks.projectAcpTranscriptUpdates,
    VirtualizedMessageList: ({ messages }: { messages: Array<{ id: string; text?: string }> }) =>
      createMockElement('div', null, messages.map(renderItem)),
  };
});

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    session: {
      readSubagentTranscript: {
        useInfiniteQuery: (...args: unknown[]) => {
          mocks.useInfiniteQuery(...args);
          return {
            ...mocks.queryResult,
            fetchNextPage: mocks.fetchNextPage,
            refetch: mocks.refetch,
          };
        },
      },
    },
  },
}));

function selection(overrides: Partial<SubagentSelection['subagent']> = {}): SubagentSelection {
  return {
    parentSessionId: 'session-1',
    parentSessionName: 'Session 1',
    subagent: {
      id: 'child-1',
      name: 'Security review',
      status: 'running',
      createdAt: '2026-08-08T11:50:00.000Z',
      updatedAt: '2026-08-08T11:59:00.000Z',
      completedAt: null,
      latestActivity: 'Checking authentication boundaries',
      resultPreview: null,
      ...overrides,
    },
  };
}

const message = (id: string, text: string, order: number): ChatMessage => ({
  id,
  source: 'user',
  text,
  timestamp: '1970-01-01T00:00:00.000Z',
  order,
});

describe('SubagentTranscriptContent', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      writable: true,
      value: true,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    void act(() => root.unmount());
    document.body.innerHTML = '';
  });

  function render(
    state: Parameters<typeof SubagentTranscriptContent>[0]['state'],
    options: { selected?: SubagentSelection } = {}
  ) {
    void act(() =>
      root.render(
        createElement(SubagentTranscriptContent, {
          workspaceId: 'workspace-1',
          selection: options.selected ?? selection(),
          state,
        })
      )
    );
  }

  it('renders transcript content without breadcrumb, back action, or status pills', () => {
    render({
      kind: 'ready',
      messages: [message('message-1', 'Review complete', 0)],
      hasOlder: false,
      loadingOlder: false,
      onLoadOlder: vi.fn(),
    });

    expect(container.textContent).toContain('Review complete');
    expect(container.textContent).not.toContain('Session 1');
    expect(container.textContent).not.toContain('Security review');
    expect(container.textContent).not.toContain('Read only');
    expect(container.textContent).not.toContain('Running');
    expect(
      [...container.querySelectorAll('button')].some((button) => button.textContent === 'Back')
    ).toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
    for (const forbidden of ['Composer', 'Permission', 'Stop', 'Steer', 'Close', 'Archive']) {
      expect(container.textContent).not.toContain(forbidden);
    }
  });

  it.each([
    ['loading', { kind: 'loading' } as const, 'Loading transcript…'],
    ['empty', { kind: 'empty' } as const, 'No transcript messages yet.'],
  ])('renders the %s transcript state', (_name, state, expectedText) => {
    render(state);
    expect(container.textContent).toContain(expectedText);
  });

  it('retains the terminal preview when the transcript is unavailable and retries in place', () => {
    const onRetry = vi.fn();
    render(
      { kind: 'unavailable', message: 'Provider history expired', onRetry },
      {
        selected: selection({
          status: 'failed',
          latestActivity: null,
          resultPreview: 'Static analysis stopped after an invalid response.',
        }),
      }
    );

    expect(container.textContent).toContain('Transcript unavailable');
    expect(container.textContent).toContain('Provider history expired');
    expect(container.textContent).toContain('Static analysis stopped after an invalid response.');
    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry'
    );
    void act(() => retry?.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('SubagentTranscriptView', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      writable: true,
      value: true,
    });
    mocks.queryResult.data = undefined;
    mocks.queryResult.error = null;
    mocks.queryResult.isLoading = false;
    mocks.queryResult.isFetchingNextPage = false;
    mocks.queryResult.isFetchNextPageError = false;
    mocks.queryResult.isRefetchError = false;
    mocks.queryResult.hasNextPage = false;
    mocks.fetchNextPage.mockClear();
    mocks.refetch.mockClear();
    mocks.projectAcpTranscriptUpdates.mockClear();
    mocks.useInfiniteQuery.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    void act(() => root.unmount());
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  function render() {
    void act(() =>
      root.render(
        createElement(SubagentTranscriptView, {
          workspaceId: 'workspace-1',
          selection: selection(),
        })
      )
    );
  }

  it('requests and projects the initial newest transcript page', () => {
    mocks.queryResult.data = {
      pages: [
        {
          projectionBoundary: 'turn',
          updates: [
            {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'Newest transcript turn' },
            },
          ],
          nextCursor: 'older-page',
        },
      ],
    };
    mocks.queryResult.hasNextPage = true;

    render();

    expect(mocks.useInfiniteQuery).toHaveBeenLastCalledWith(
      { sessionId: 'session-1', subagentId: 'child-1', cursor: null, limit: 10 },
      expect.objectContaining({ getNextPageParam: expect.any(Function) })
    );
    expect(container.textContent).toContain('Newest transcript turn');
    expect(container.textContent).toContain('Load older');
  });

  it('prepends older pages in transcript order', async () => {
    const newestPage = {
      projectionBoundary: 'turn' as const,
      updates: [
        {
          sessionUpdate: 'user_message_chunk' as const,
          content: { type: 'text' as const, text: 'Newest transcript turn' },
        },
      ],
      nextCursor: 'older-page',
    };
    const olderPage = {
      projectionBoundary: 'turn' as const,
      updates: [
        {
          sessionUpdate: 'user_message_chunk' as const,
          content: { type: 'text' as const, text: 'Older transcript turn' },
        },
      ],
      nextCursor: null,
    };
    mocks.queryResult.data = { pages: [newestPage] };
    mocks.queryResult.hasNextPage = true;
    render();

    const loadOlder = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Load older'
    );

    await act(async () => loadOlder?.click());
    expect(mocks.fetchNextPage).toHaveBeenCalledOnce();

    mocks.queryResult.data = { pages: [newestPage, olderPage] };
    mocks.queryResult.hasNextPage = false;
    render();

    const text = container.textContent ?? '';
    expect(text.indexOf('Older transcript turn')).toBeLessThan(
      text.indexOf('Newest transcript turn')
    );
  });

  it('projects only the newly loaded provider page when older history is appended', () => {
    const newestPage = {
      projectionBoundary: 'turn' as const,
      updates: [
        {
          sessionUpdate: 'user_message_chunk' as const,
          content: { type: 'text' as const, text: 'Newest transcript turn' },
        },
      ],
      nextCursor: 'older-page',
    };
    const olderPage = {
      projectionBoundary: 'turn' as const,
      updates: [
        {
          sessionUpdate: 'user_message_chunk' as const,
          content: { type: 'text' as const, text: 'Older transcript turn' },
        },
      ],
      nextCursor: null,
    };
    mocks.queryResult.data = { pages: [newestPage] };
    render();

    mocks.queryResult.data = { pages: [newestPage, olderPage] };
    render();

    expect(mocks.projectAcpTranscriptUpdates).toHaveBeenCalledTimes(2);
    expect(mocks.projectAcpTranscriptUpdates).toHaveBeenNthCalledWith(1, newestPage.updates);
    expect(mocks.projectAcpTranscriptUpdates).toHaveBeenNthCalledWith(2, olderPage.updates);
  });

  it('refetches only matching live sub-agent transcript changes', () => {
    mocks.queryResult.data = {
      pages: [{ projectionBoundary: 'turn', updates: [], nextCursor: null }],
    };
    render();

    void act(() => {
      dispatchSubagentChange({
        sessionId: 'session-1',
        subagentId: 'another-child',
        change: 'updated',
      });
    });
    expect(mocks.refetch).not.toHaveBeenCalled();

    void act(() => {
      dispatchSubagentChange({
        sessionId: 'session-1',
        subagentId: 'child-1',
        change: 'completed',
      });
    });
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });

  it('keeps loaded messages visible and retries the older page after pagination fails', () => {
    mocks.queryResult.data = {
      pages: [
        {
          projectionBoundary: 'turn',
          updates: [
            {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'Keep this loaded transcript turn' },
            },
          ],
          nextCursor: 'older-page',
        },
      ],
    };
    mocks.queryResult.error = new Error('Older transcript page failed');
    mocks.queryResult.isFetchNextPageError = true;
    mocks.queryResult.hasNextPage = true;
    render();

    expect(container.textContent).toContain('Keep this loaded transcript turn');
    expect(container.textContent).toContain('Older transcript page failed');
    expect(container.textContent).not.toContain('Transcript unavailable');

    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry'
    );
    void act(() => retry?.click());
    expect(mocks.fetchNextPage).toHaveBeenCalledOnce();
    expect(mocks.refetch).not.toHaveBeenCalled();
  });

  it('keeps loaded messages visible and retries all active pages after a refresh fails', () => {
    mocks.queryResult.data = {
      pages: [
        {
          projectionBoundary: 'turn',
          updates: [
            {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'Retain this transcript during refresh failure' },
            },
          ],
          nextCursor: null,
        },
      ],
    };
    mocks.queryResult.error = new Error('Live transcript refresh failed');
    mocks.queryResult.isRefetchError = true;
    render();

    expect(container.textContent).toContain('Retain this transcript during refresh failure');
    expect(container.textContent).toContain('Live transcript refresh failed');
    expect(container.textContent).not.toContain('Transcript unavailable');

    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry'
    );
    void act(() => retry?.click());
    expect(mocks.refetch).toHaveBeenCalledOnce();
    expect(mocks.fetchNextPage).not.toHaveBeenCalled();
  });

  it('refetches the initial transcript when the unavailable state is retried', () => {
    mocks.queryResult.error = new Error('Provider history expired');
    mocks.queryResult.data = undefined;
    render();

    expect(container.textContent).toContain('Transcript unavailable');
    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry'
    );
    void act(() => retry?.click());

    expect(mocks.refetch).toHaveBeenCalledOnce();
    expect(mocks.fetchNextPage).not.toHaveBeenCalled();
  });
});
