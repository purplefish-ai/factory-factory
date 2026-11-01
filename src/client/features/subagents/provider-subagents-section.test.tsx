// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchSubagentChange } from '@/client/lib/subagent-events';
import { ProviderSubagentsSection } from './provider-subagents-section';
import type { SubagentListItem } from './types';

const mocks = vi.hoisted(() => ({
  fetchNextPage: vi.fn(() => Promise.resolve()),
  infinitePages: undefined as unknown[] | undefined,
  pageParams: [null] as unknown[],
  invalidate: vi.fn(() => Promise.resolve()),
  queryResult: {
    data: undefined as unknown,
    error: null as Error | null,
    hasNextPage: false,
    isFetchNextPageError: false,
    isFetchingNextPage: false,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn<() => Promise<unknown>>(() => Promise.resolve()),
  },
  useQuery: vi.fn(),
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    session: {
      stopTarget: { useMutation: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) }) },
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
                ? { pages: mocks.infinitePages, pageParams: mocks.pageParams }
                : mocks.queryResult.data === undefined
                  ? undefined
                  : { pages: [mocks.queryResult.data], pageParams: mocks.pageParams },
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
    mocks.pageParams = [null];
    mocks.queryResult.error = null;
    mocks.queryResult.hasNextPage = false;
    mocks.queryResult.isFetchNextPageError = false;
    mocks.queryResult.isFetchingNextPage = false;
    mocks.queryResult.isFetching = false;
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

  it.each<{ statuses: SubagentListItem['status'][]; count: number }>([
    {
      statuses: [
        'running',
        'waiting',
        'completed',
        'completed',
        'completed',
        'failed',
        'cancelled',
        'interrupted',
      ],
      count: 2,
    },
    { statuses: ['starting', 'running', 'waiting'], count: 3 },
    { statuses: ['completed', 'failed', 'cancelled', 'interrupted'], count: 0 },
  ])('counts only active agents for $statuses', ({ statuses, count }) => {
    mocks.queryResult.data = {
      supported: true,
      subagents: statuses.map((status, index) => ({
        id: `child-${index}`,
        name: `Agent ${index}`,
        status,
        createdAt: null,
        updatedAt: null,
        completedAt: null,
        latestActivity: null,
        resultPreview: null,
      })),
      nextCursor: null,
    };
    const props = {
      sessionId: 'session-1',
      parentSessionName: 'Session 1',
      enabled: true,
      onSelect: vi.fn(),
    };
    render(props);

    expect(container.querySelector('[aria-label="Active sub-agents"]')?.textContent).toBe(
      String(count)
    );
    expect(container.querySelectorAll('button[aria-pressed]')).toHaveLength(count);

    mocks.queryResult.data = { supported: true, subagents: [], nextCursor: null };
    render(props);
    expect(container.querySelector('[aria-label="Active sub-agents"]')).toBeNull();
  });

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

  it('automatically loads every page before showing the active count', () => {
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
    const props = {
      sessionId: 'session-1',
      parentSessionName: 'Session 1',
      enabled: true,
      onSelect: vi.fn(),
    };
    render(props);

    expect(container.querySelector('[aria-label="Active sub-agents"]')).toBeNull();
    expect(container.textContent).toContain('Completed · 1');
    expect(mocks.fetchNextPage).toHaveBeenCalledOnce();

    const firstPage = mocks.queryResult.data;
    mocks.infinitePages = [firstPage, { supported: true, subagents: [], nextCursor: 'third-page' }];
    render(props);
    expect(mocks.fetchNextPage).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[aria-label="Active sub-agents"]')).toBeNull();

    mocks.infinitePages = [
      ...mocks.infinitePages,
      {
        supported: true,
        subagents: [
          { ...first, id: 'active-1', status: 'starting' },
          { ...first, id: 'active-2', status: 'waiting' },
        ],
        nextCursor: null,
      },
    ];
    mocks.queryResult.hasNextPage = false;
    render(props);

    expect(container.querySelector('[aria-label="Active sub-agents"]')?.textContent).toBe('2');
    expect(container.textContent).toContain('Completed · 1');
  });

  it('waits for an in-flight request before automatically fetching another page', () => {
    mocks.queryResult.data = { supported: true, subagents: [], nextCursor: 'next-page' };
    mocks.queryResult.hasNextPage = true;
    mocks.queryResult.isFetching = true;
    render({
      sessionId: 'session-1',
      parentSessionName: 'Session 1',
      enabled: true,
      onSelect: vi.fn(),
    });
    expect(mocks.fetchNextPage).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'stops repeated cursors and offers retry when hasNextPage is %s',
    (hasNextPage) => {
      const loaded = {
        id: 'loaded-agent',
        name: 'Loaded agent',
        status: 'running',
        createdAt: null,
        updatedAt: null,
        completedAt: null,
        latestActivity: null,
        resultPreview: null,
      };
      mocks.infinitePages = [
        { supported: true, subagents: [loaded], nextCursor: 'repeated' },
        { supported: true, subagents: [], nextCursor: 'latest' },
        { supported: true, subagents: [], nextCursor: 'repeated' },
      ];
      mocks.pageParams = [null, 'repeated', 'latest'];
      mocks.queryResult.hasNextPage = hasNextPage;
      render({
        sessionId: 'session-1',
        parentSessionName: 'Session 1',
        enabled: true,
        onSelect: vi.fn(),
      });

      expect(mocks.fetchNextPage).not.toHaveBeenCalled();
      expect(container.textContent).toContain('Loaded agent');
      expect(container.textContent).toContain(
        'The provider repeated a sub-agent page cursor. Retry to reload the list.'
      );
      expect(container.querySelector('[aria-label="Active sub-agents"]')).toBeNull();
      const retry = [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Retry'
      );
      void act(() => retry?.click());
      expect(mocks.queryResult.refetch).toHaveBeenCalledOnce();
    }
  );

  it('keeps loaded sub-agents visible and retries only the failed next page', () => {
    const first = {
      id: 'child-first-page',
      name: 'Keep this loaded agent',
      status: 'running' as const,
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
    mocks.queryResult.error = new Error('Older sub-agent page failed');
    mocks.queryResult.hasNextPage = true;
    mocks.queryResult.isFetchNextPageError = true;

    render({
      sessionId: 'session-1',
      parentSessionName: 'Session 1',
      enabled: true,
      onSelect: vi.fn(),
    });

    expect(container.textContent).toContain('Keep this loaded agent');
    expect(container.textContent).toContain('Older sub-agent page failed');
    expect(container.querySelector('[aria-label="Active sub-agents"]')).toBeNull();
    expect(mocks.fetchNextPage).not.toHaveBeenCalled();
    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry'
    );
    void act(() => retry?.click());

    expect(mocks.fetchNextPage).toHaveBeenCalledOnce();
    expect(mocks.queryResult.refetch).not.toHaveBeenCalled();
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
  it('keeps cached children browseable while withdrawing controls on disconnect or parent stop', async () => {
    const child: SubagentListItem = {
      id: 'child',
      name: 'Child',
      status: 'running',
      createdAt: null,
      updatedAt: null,
      completedAt: null,
      latestActivity: null,
      resultPreview: null,
      stopControl: { runtimeId: 'runtime', controlId: 'live' },
    };
    mocks.queryResult.data = { supported: true, subagents: [child], nextCursor: null };
    const props = {
      sessionId: 'parent',
      parentSessionName: 'Parent',
      enabled: true,
      onSelect: vi.fn(),
    };
    mocks.queryResult.refetch.mockResolvedValue({ isError: false, data: mocks.queryResult.data });
    await act(() =>
      root.render(
        createElement(ProviderSubagentsSection, {
          ...props,
          controlSessionId: 'parent',
          controlRuntimeId: 'runtime',
        })
      )
    );
    expect(container.querySelector('button[aria-label="Stop subagent"]')).not.toBeNull();
    render(props);
    expect(container.textContent).toContain('Child');
    expect(container.querySelector('button[aria-label="Stop subagent"]')).toBeNull();
  });
  it('fences cached child controls until a successful refresh for the current live runtime', async () => {
    const child = {
      id: 'child',
      name: 'Child',
      status: 'running',
      createdAt: null,
      updatedAt: null,
      completedAt: null,
      latestActivity: null,
      resultPreview: null,
      stopControl: { controlId: 'old-live', runtimeId: 'old-runtime' },
    };
    mocks.queryResult.data = { supported: true, subagents: [child], nextCursor: null };
    const props = {
      sessionId: 'parent',
      parentSessionName: 'Parent',
      enabled: true,
      onSelect: vi.fn(),
      controlSessionId: 'parent',
      controlRuntimeId: 'old-runtime',
    };
    let finish!: (result: unknown) => void;
    mocks.queryResult.refetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await act(() => root.render(createElement(ProviderSubagentsSection, props)));
    expect(container.querySelector('button[aria-label="Stop subagent"]')).toBeNull();
    await act(() => finish({ isError: false, data: mocks.queryResult.data }));
    expect(container.querySelector('button[aria-label="Stop subagent"]')).not.toBeNull();
    await act(() =>
      root.render(
        createElement(ProviderSubagentsSection, { ...props, controlSessionId: undefined })
      )
    );
    await act(() =>
      root.render(
        createElement(ProviderSubagentsSection, { ...props, controlRuntimeId: 'new-runtime' })
      )
    );
    expect(container.textContent).toContain('Child');
    expect(container.querySelector('button[aria-label="Stop subagent"]')).toBeNull();
    await act(() => finish({ isError: true, data: mocks.queryResult.data }));
    expect(container.querySelector('button[aria-label="Stop subagent"]')).toBeNull();
    await act(() =>
      root.render(
        createElement(ProviderSubagentsSection, { ...props, controlSessionId: undefined })
      )
    );
    mocks.queryResult.data = {
      supported: true,
      subagents: [{ ...child, stopControl: { controlId: 'new-live', runtimeId: 'new-runtime' } }],
      nextCursor: null,
    };
    await act(() =>
      root.render(
        createElement(ProviderSubagentsSection, { ...props, controlRuntimeId: 'new-runtime' })
      )
    );
    expect(container.querySelector('button[aria-label="Stop subagent"]')).toBeNull();
    await act(() => finish({ isError: false, data: mocks.queryResult.data }));
    expect(container.querySelector('button[aria-label="Stop subagent"]')).not.toBeNull();
  });
});
