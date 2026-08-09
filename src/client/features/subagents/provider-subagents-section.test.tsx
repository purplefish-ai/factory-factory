// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchSubagentChange } from '@/client/lib/subagent-events';
import { ProviderSubagentsSection } from './provider-subagents-section';

const mocks = vi.hoisted(() => ({
  fetchNextPage: vi.fn(() => Promise.resolve()),
  infinitePages: undefined as unknown[] | undefined,
  invalidate: vi.fn(() => Promise.resolve()),
  queryResult: {
    data: undefined as unknown,
    error: null as Error | null,
    hasNextPage: false,
    isFetchingNextPage: false,
    isLoading: false,
    refetch: vi.fn(() => Promise.resolve()),
  },
  useQuery: vi.fn(),
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    session: {
      listSubagents: {
        useQuery: (...args: unknown[]) => {
          mocks.useQuery(...args);
          return { ...mocks.queryResult, fetchNextPage: mocks.fetchNextPage };
        },
        useInfiniteQuery: (...args: unknown[]) => {
          mocks.useQuery(...args);
          return {
            ...mocks.queryResult,
            data:
              mocks.infinitePages !== undefined
                ? { pages: mocks.infinitePages }
                : mocks.queryResult.data === undefined
                  ? undefined
                  : { pages: [mocks.queryResult.data] },
            fetchNextPage: mocks.fetchNextPage,
          };
        },
      },
    },
    useUtils: () => ({
      session: { listSubagents: { invalidate: mocks.invalidate } },
    }),
  },
}));

describe('ProviderSubagentsSection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      writable: true,
      value: true,
    });
    mocks.queryResult.data = undefined;
    mocks.infinitePages = undefined;
    mocks.queryResult.error = null;
    mocks.queryResult.hasNextPage = false;
    mocks.queryResult.isFetchingNextPage = false;
    mocks.queryResult.isLoading = false;
    mocks.fetchNextPage.mockClear();
    mocks.queryResult.refetch.mockClear();
    mocks.invalidate.mockClear();
    mocks.useQuery.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    void act(() => root.unmount());
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  function render(props: Parameters<typeof ProviderSubagentsSection>[0]) {
    void act(() => root.render(createElement(ProviderSubagentsSection, props)));
  }

  it('keeps the parent-scoped query disabled until the selected session is hydrated', () => {
    render({
      sessionId: 'session-1',
      parentSessionName: 'Session 1',
      enabled: false,
      onSelect: vi.fn(),
    });

    expect(mocks.useQuery).toHaveBeenLastCalledWith(
      { sessionId: 'session-1', cursor: null, limit: 100 },
      expect.objectContaining({ enabled: false })
    );
    expect(container.innerHTML).toBe('');
  });

  it('queries exactly the selected ready parent session', () => {
    mocks.queryResult.isLoading = true;
    render({
      sessionId: 'session-1',
      parentSessionName: 'Session 1',
      enabled: true,
      onSelect: vi.fn(),
    });

    expect(mocks.useQuery).toHaveBeenLastCalledWith(
      { sessionId: 'session-1', cursor: null, limit: 100 },
      expect.objectContaining({ enabled: true, refetchOnMount: 'always' })
    );
    expect(container.textContent).toContain('Sub-agents');
  });

  it('invalidates the selected session before enabling its query on reconnect', async () => {
    let finishInvalidation: (() => void) | undefined;
    mocks.invalidate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishInvalidation = resolve;
        })
    );
    render({
      sessionId: 'session-1',
      parentSessionName: 'Session 1',
      enabled: false,
      onSelect: vi.fn(),
    });
    render({
      sessionId: 'session-1',
      parentSessionName: 'Session 1',
      enabled: true,
      onSelect: vi.fn(),
    });

    expect(mocks.invalidate).toHaveBeenCalledOnce();
    expect(mocks.invalidate).toHaveBeenCalledWith({
      sessionId: 'session-1',
      cursor: null,
      limit: 100,
    });
    expect(mocks.useQuery).toHaveBeenLastCalledWith(
      { sessionId: 'session-1', cursor: null, limit: 100 },
      expect.objectContaining({ enabled: false })
    );

    await act(async () => finishInvalidation?.());

    expect(mocks.useQuery).toHaveBeenLastCalledWith(
      { sessionId: 'session-1', cursor: null, limit: 100 },
      expect.objectContaining({ enabled: true })
    );
  });

  it('invalidates only browser events for the selected parent session', () => {
    render({
      sessionId: 'session-1',
      parentSessionName: 'Session 1',
      enabled: true,
      onSelect: vi.fn(),
    });

    void act(() => {
      dispatchSubagentChange({
        sessionId: 'session-2',
        subagentId: 'other-child',
        change: 'updated',
      });
    });
    expect(mocks.invalidate).not.toHaveBeenCalled();

    void act(() => {
      dispatchSubagentChange({
        sessionId: 'session-1',
        subagentId: 'child-1',
        change: 'completed',
      });
    });
    expect(mocks.invalidate).toHaveBeenCalledOnce();
    expect(mocks.invalidate).toHaveBeenCalledWith({
      sessionId: 'session-1',
      cursor: null,
      limit: 100,
    });
  });

  it('omits the entire section for unsupported providers', () => {
    mocks.queryResult.data = { supported: false };
    render({
      sessionId: 'session-1',
      parentSessionName: 'Session 1',
      enabled: true,
      onSelect: vi.fn(),
    });
    expect(container.innerHTML).toBe('');
  });

  it('selects a sub-agent with its parent session identity', () => {
    const onSelect = vi.fn();
    const item = {
      id: 'child-1',
      name: 'Security review',
      status: 'running' as const,
      createdAt: '2026-08-08T11:50:00.000Z',
      updatedAt: '2026-08-08T11:59:00.000Z',
      completedAt: null,
      latestActivity: 'Reviewing permissions',
      resultPreview: null,
    };
    mocks.queryResult.data = { supported: true, subagents: [item], nextCursor: null };
    render({ sessionId: 'session-1', parentSessionName: 'Session 1', enabled: true, onSelect });

    const row = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Security review')
    );
    void act(() => row?.click());
    expect(onSelect).toHaveBeenCalledWith({
      parentSessionId: 'session-1',
      parentSessionName: 'Session 1',
      subagent: item,
    });
  });

  it('selects sub-agents from unnamed sessions with a breadcrumb fallback', () => {
    const onSelect = vi.fn();
    const item = {
      id: 'child-unnamed',
      name: 'Inspect cache',
      status: 'running' as const,
      createdAt: null,
      updatedAt: null,
      completedAt: null,
      latestActivity: null,
      resultPreview: null,
    };
    mocks.queryResult.data = { supported: true, subagents: [item], nextCursor: null };
    render({ sessionId: 'session-1', parentSessionName: null, enabled: true, onSelect });

    const row = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Inspect cache')
    );
    void act(() => row?.click());

    expect(onSelect).toHaveBeenCalledWith({
      parentSessionId: 'session-1',
      parentSessionName: 'Untitled session',
      subagent: item,
    });
  });

  it('loads later provider pages without discarding already visible sub-agents', () => {
    const first = {
      id: 'child-first-page',
      name: 'First page agent',
      status: 'completed' as const,
      createdAt: null,
      updatedAt: null,
      completedAt: null,
      latestActivity: null,
      resultPreview: null,
    };
    mocks.queryResult.data = {
      supported: true,
      subagents: [first],
      nextCursor: 'second-page',
    };
    mocks.queryResult.hasNextPage = true;
    render({
      sessionId: 'session-1',
      parentSessionName: 'Session 1',
      enabled: true,
      onSelect: vi.fn(),
    });

    const loadMore = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Load more'
    );
    expect(loadMore).toBeDefined();
    void act(() => loadMore?.click());

    expect(mocks.fetchNextPage).toHaveBeenCalledOnce();
  });

  it('combines loaded provider pages into one deduplicated list', () => {
    const item = (id: string, name: string) => ({
      id,
      name,
      status: 'running' as const,
      createdAt: null,
      updatedAt: null,
      completedAt: null,
      latestActivity: null,
      resultPreview: null,
    });
    mocks.infinitePages = [
      {
        supported: true,
        subagents: [item('newest-child', 'Newest agent')],
        nextCursor: 'older-page',
      },
      {
        supported: true,
        subagents: [
          item('newest-child', 'Newest agent refreshed'),
          item('older-child', 'Older agent'),
        ],
        nextCursor: null,
      },
    ];
    render({
      sessionId: 'session-1',
      parentSessionName: 'Session 1',
      enabled: true,
      onSelect: vi.fn(),
    });

    expect(container.textContent).toContain('Newest agent');
    expect(container.textContent).not.toContain('Newest agent refreshed');
    expect(container.textContent).toContain('Older agent');
    expect(container.querySelectorAll('button[aria-pressed]').length).toBe(2);
  });

  it('collapses completed sub-agents again when the selected session changes', () => {
    const completed = {
      id: 'child-complete',
      name: 'Finished audit',
      status: 'completed' as const,
      createdAt: '2026-08-08T11:00:00.000Z',
      updatedAt: '2026-08-08T11:10:00.000Z',
      completedAt: '2026-08-08T11:10:00.000Z',
      latestActivity: null,
      resultPreview: 'Audit complete',
    };
    mocks.queryResult.data = { supported: true, subagents: [completed], nextCursor: null };
    render({
      sessionId: 'session-1',
      parentSessionName: 'Session 1',
      enabled: true,
      onSelect: vi.fn(),
    });

    const completedButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Completed · 1')
    );
    void act(() => completedButton?.click());
    expect(container.textContent).toContain('Finished audit');

    render({
      sessionId: 'session-2',
      parentSessionName: 'Session 2',
      enabled: true,
      onSelect: vi.fn(),
    });
    expect(container.textContent).not.toContain('Finished audit');
  });
});
