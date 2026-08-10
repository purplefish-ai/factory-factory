// @vitest-environment jsdom

import { act, createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentSelection } from '@/client/features/subagents';
import { MainViewContent } from '@/client/features/workspace';

const mocks = vi.hoisted(() => ({
  readSubagentTranscript: vi.fn(),
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    session: {
      readSubagentTranscript: {
        useInfiniteQuery: mocks.readSubagentTranscript,
      },
    },
  },
}));

vi.mock('./workspace-detail-container', () => ({
  WorkspaceDetailContainer: () => {
    const { id: workspaceId = '' } = useParams<{ id: string }>();
    return (
      <MainViewContent workspaceId={workspaceId}>
        <div data-testid="chat-content">Chat content</div>
      </MainViewContent>
    );
  },
}));

import WorkspaceDetailPage from './detail';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});

const FIRST_WORKSPACE_ID = 'workspace-first';
const SECOND_WORKSPACE_ID = 'workspace-second';
const firstWorkspaceSelection: SubagentSelection = {
  parentSessionId: 'session-first',
  parentSessionName: 'First chat',
  subagent: {
    id: 'child-first',
    name: 'First workspace review',
    status: 'running',
    createdAt: '2026-08-10T10:00:00.000Z',
    updatedAt: '2026-08-10T10:01:00.000Z',
    completedAt: null,
    latestActivity: 'Inspecting the first workspace',
    resultPreview: null,
  },
};

function seedActiveSubagentTab(workspaceId: string, selection: SubagentSelection) {
  const tabId = `subagent-${selection.parentSessionId}-${selection.subagent.id}`;
  localStorage.setItem(
    `workspace-panel-tabs-${workspaceId}`,
    JSON.stringify([
      { id: 'chat', type: 'chat', label: 'Chat' },
      {
        id: tabId,
        type: 'subagent',
        label: selection.subagent.name,
        subagentSelection: selection,
      },
    ])
  );
  localStorage.setItem(`workspace-panel-active-tab-${workspaceId}`, tabId);
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  mocks.readSubagentTranscript.mockReturnValue({
    data: undefined,
    error: null,
    isLoading: true,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(() => Promise.resolve()),
    refetch: vi.fn(() => Promise.resolve()),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('WorkspaceDetailPage', () => {
  it('does not render or query a persisted sub-agent tab from the previous workspace', async () => {
    seedActiveSubagentTab(FIRST_WORKSPACE_ID, firstWorkspaceSelection);
    const router = createMemoryRouter(
      [
        {
          path: '/projects/:slug/workspaces/:id',
          element: createElement(WorkspaceDetailPage),
        },
      ],
      { initialEntries: [`/projects/project/workspaces/${FIRST_WORKSPACE_ID}`] }
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(() => {
      root.render(createElement(RouterProvider, { router }));
    });
    await vi.waitFor(() => {
      expect(mocks.readSubagentTranscript).toHaveBeenCalledWith(
        {
          sessionId: 'session-first',
          subagentId: 'child-first',
          cursor: null,
          limit: 10,
        },
        expect.any(Object)
      );
    });

    mocks.readSubagentTranscript.mockClear();
    await act(async () => {
      flushSync(() => {
        void router.navigate(`/projects/project/workspaces/${SECOND_WORKSPACE_ID}`);
      });
      await Promise.resolve();
    });

    expect(mocks.readSubagentTranscript).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Loading transcript…');

    await act(() => root.unmount());
  });
});
