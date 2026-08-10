// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchSubagentChange } from '@/client/lib/subagent-events';
import type { SubagentSelection } from './types';
import { useLiveSubagentSelection } from './use-live-subagent-selection';

const mocks = vi.hoisted(() => ({
  listRefetch: vi.fn(() => Promise.resolve()),
  listQueryResult: { data: undefined as unknown },
  useListQuery: vi.fn(),
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    session: {
      listSubagents: {
        useQuery: (...args: unknown[]) => {
          mocks.useListQuery(...args);
          return { ...mocks.listQueryResult, refetch: mocks.listRefetch };
        },
      },
    },
  },
}));

function selection(): SubagentSelection {
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
    },
  };
}

function LiveSelectionProbe() {
  const current = useLiveSubagentSelection(selection());
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
    mocks.listQueryResult.data = undefined;
    mocks.listRefetch.mockClear();
    mocks.useListQuery.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    void act(() => root.unmount());
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  function renderHookProbe() {
    void act(() => root.render(createElement(LiveSelectionProbe)));
  }

  it('returns the authoritative provider summary and refetches only matching invalidations', () => {
    const completed = {
      ...selection().subagent,
      name: 'Completed security review',
      status: 'completed' as const,
      completedAt: '2026-08-10T10:05:00.000Z',
    };
    mocks.listQueryResult.data = {
      supported: true,
      subagents: [completed],
      nextCursor: null,
    };
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
});
