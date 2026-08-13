// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchSubagentChange } from '@/client/lib/subagent-events';
import type { SubagentSelection } from './types';
import { useLiveSubagentSelection } from './use-live-subagent-selection';

const mocks = vi.hoisted(() => ({
  fetchNextPage: vi.fn(() => Promise.resolve()),
  listRefetch: vi.fn(() => Promise.resolve()),
  listInfiniteQueryResult: {
    data: undefined as unknown,
    dataUpdatedAt: 0,
    hasNextPage: false,
    isFetchedAfterMount: false,
    isFetching: false,
    isFetchNextPageError: false,
    isSuccess: true,
  },
  useListInfiniteQuery: vi.fn(),
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    session: {
      listSubagents: {
        useInfiniteQuery: (...args: unknown[]) => {
          mocks.useListInfiniteQuery(...args);
          return {
            ...mocks.listInfiniteQueryResult,
            fetchNextPage: mocks.fetchNextPage,
            refetch: mocks.listRefetch,
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
      createdAt: '2026-08-10T10:00:00.000Z',
      updatedAt: '2026-08-10T10:00:00.000Z',
      completedAt: null,
      latestActivity: 'Checking authentication boundaries',
      resultPreview: null,
      ...overrides,
    },
  };
}

function LiveSelectionProbe({ selected }: { selected: SubagentSelection }) {
  const current = useLiveSubagentSelection(selected);
  return createElement('output', null, JSON.stringify(current));
}

describe('useLiveSubagentSelection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      writable: true,
      value: true,
    });
    mocks.listInfiniteQueryResult.data = undefined;
    mocks.listInfiniteQueryResult.dataUpdatedAt = 0;
    mocks.listInfiniteQueryResult.hasNextPage = false;
    mocks.listInfiniteQueryResult.isFetchedAfterMount = false;
    mocks.listInfiniteQueryResult.isFetching = false;
    mocks.listInfiniteQueryResult.isFetchNextPageError = false;
    mocks.listInfiniteQueryResult.isSuccess = true;
    mocks.fetchNextPage.mockClear();
    mocks.listRefetch.mockClear();
    mocks.useListInfiniteQuery.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    void act(() => root.unmount());
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  function setPages(
    pages: Array<{
      supported: true;
      subagents: SubagentSelection['subagent'][];
      nextCursor: string | null;
    }>
  ) {
    mocks.listInfiniteQueryResult.data = { pages, pageParams: pages.map(() => null) };
  }

  function renderHookProbe(selected = selection()) {
    void act(() => root.render(createElement(LiveSelectionProbe, { selected })));
  }

  it('returns the authoritative provider summary and refetches only matching invalidations', () => {
    const completed = {
      ...selection().subagent,
      name: 'Completed security review',
      status: 'completed' as const,
      completedAt: '2026-08-10T10:05:00.000Z',
    };
    setPages([{ supported: true, subagents: [completed], nextCursor: null }]);
    renderHookProbe();
    expect(JSON.parse(container.textContent ?? '')).toEqual({
      ...selection(),
      subagent: completed,
    });

    void act(() =>
      dispatchSubagentChange({
        sessionId: 'another-session',
        subagentId: 'child-1',
        change: 'completed',
      })
    );
    expect(mocks.listRefetch).not.toHaveBeenCalled();

    void act(() =>
      dispatchSubagentChange({
        sessionId: 'session-1',
        subagentId: 'child-1',
        change: 'completed',
      })
    );
    expect(mocks.listRefetch).toHaveBeenCalledOnce();
  });

  it('does not replace a reopened tab selection with an older cached summary', () => {
    const reopened = selection({
      status: 'completed',
      updatedAt: '2026-08-10T10:05:00.000Z',
      completedAt: '2026-08-10T10:05:00.000Z',
      resultPreview: 'Review complete',
    });
    setPages([
      {
        supported: true,
        subagents: [
          selection({
            status: 'running',
            updatedAt: '2026-08-10T10:01:00.000Z',
            latestActivity: 'Still checking authentication boundaries',
          }).subagent,
        ],
        nextCursor: null,
      },
    ]);

    renderHookProbe(reopened);

    expect(JSON.parse(container.textContent ?? '')).toEqual(reopened);
  });

  it('does not regress a terminal selection at an equal timestamp', () => {
    const terminal = selection({
      status: 'completed',
      updatedAt: '2026-08-10T10:05:00.000Z',
      completedAt: '2026-08-10T10:05:00.000Z',
    });
    setPages([
      {
        supported: true,
        subagents: [
          selection({
            status: 'running',
            updatedAt: '2026-08-10T10:05:00.000Z',
          }).subagent,
        ],
        nextCursor: null,
      },
    ]);

    renderHookProbe(terminal);

    expect(JSON.parse(container.textContent ?? '')).toEqual(terminal);
  });

  it.each([
    ['an unknown stored timestamp', null, '2026-08-10T10:05:00.000Z'],
    ['an invalid stored timestamp', 'not-a-date', '2026-08-10T10:05:00.000Z'],
    ['an unknown cached timestamp', '2026-08-10T10:00:00.000Z', null],
    ['an invalid cached timestamp', '2026-08-10T10:00:00.000Z', 'not-a-date'],
  ] as const)('keeps the stored selection from initial cache when freshness is unprovable from %s', (_case, storedUpdatedAt, cachedUpdatedAt) => {
    const stored = selection({ updatedAt: storedUpdatedAt });
    setPages([
      {
        supported: true,
        subagents: [
          selection({
            status: 'completed',
            updatedAt: cachedUpdatedAt,
            completedAt: '2026-08-10T10:05:00.000Z',
          }).subagent,
        ],
        nextCursor: null,
      },
    ]);

    renderHookProbe(stored);

    expect(JSON.parse(container.textContent ?? '')).toEqual(stored);
  });

  it('accepts a terminal-safe null-timestamp summary after a successful post-mount fetch', () => {
    const stored = selection({
      name: 'Restored security review',
      status: 'running',
      updatedAt: null,
    });
    const fetched = selection({
      name: 'Provider-completed security review',
      status: 'completed',
      updatedAt: null,
      completedAt: '2026-08-10T10:05:00.000Z',
    }).subagent;
    setPages([{ supported: true, subagents: [fetched], nextCursor: null }]);

    renderHookProbe(stored);
    expect(JSON.parse(container.textContent ?? '')).toEqual(stored);

    mocks.listInfiniteQueryResult.isFetchedAfterMount = true;
    mocks.listInfiniteQueryResult.dataUpdatedAt = Date.parse('2026-08-10T10:05:00.000Z');
    renderHookProbe(stored);
    expect(JSON.parse(container.textContent ?? '')).toEqual({ ...stored, subagent: fetched });
  });

  it('keeps a successful null-timestamp summary after a refetch error', () => {
    const stored = selection({
      name: 'Restored security review',
      status: 'running',
      updatedAt: null,
    });
    const fetched = selection({
      name: 'Provider-completed security review',
      status: 'completed',
      updatedAt: null,
      completedAt: '2026-08-10T10:05:00.000Z',
    }).subagent;
    setPages([{ supported: true, subagents: [fetched], nextCursor: null }]);
    mocks.listInfiniteQueryResult.dataUpdatedAt = Date.parse('2026-08-10T10:05:00.000Z');
    mocks.listInfiniteQueryResult.isFetchedAfterMount = true;

    renderHookProbe(stored);
    expect(JSON.parse(container.textContent ?? '')).toEqual({ ...stored, subagent: fetched });

    mocks.listInfiniteQueryResult.isSuccess = false;
    renderHookProbe(stored);

    expect(JSON.parse(container.textContent ?? '')).toEqual({ ...stored, subagent: fetched });
  });

  it('fetches successive pages until it refreshes a restored later-page child', () => {
    const stored = selection();
    const completed = selection({
      status: 'completed',
      updatedAt: '2026-08-10T10:05:00.000Z',
      completedAt: '2026-08-10T10:05:00.000Z',
      resultPreview: 'Review complete',
    }).subagent;
    const firstPage = {
      supported: true as const,
      subagents: [selection({ id: 'child-100' }).subagent],
      nextCursor: 'page-2',
    };
    const secondPage = {
      supported: true as const,
      subagents: [selection({ id: 'child-200' }).subagent],
      nextCursor: 'page-3',
    };
    setPages([firstPage]);
    mocks.listInfiniteQueryResult.hasNextPage = true;

    renderHookProbe(stored);
    expect(mocks.fetchNextPage).toHaveBeenCalledOnce();

    setPages([firstPage, secondPage]);
    renderHookProbe(stored);
    expect(mocks.fetchNextPage).toHaveBeenCalledTimes(2);

    setPages([
      firstPage,
      secondPage,
      { supported: true, subagents: [completed], nextCursor: null },
    ]);
    mocks.listInfiniteQueryResult.hasNextPage = false;
    mocks.listInfiniteQueryResult.isFetchedAfterMount = true;
    renderHookProbe(stored);

    expect(JSON.parse(container.textContent ?? '')).toEqual({
      ...stored,
      subagent: completed,
    });
  });
});
