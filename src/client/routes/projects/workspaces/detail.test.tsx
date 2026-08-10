// @vitest-environment jsdom

import { act, createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentSelection } from '@/client/features/subagents';
import { MainViewContent } from '@/client/features/workspace';
import {
  cleanupSubagentTabTestEnvironment,
  createLoadingSubagentTranscriptQuery,
  seedSubagentTab,
  setupSubagentTabTestEnvironment,
} from '@/test-utils/subagent-tabs';

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

beforeEach(() => {
  setupSubagentTabTestEnvironment();
  mocks.readSubagentTranscript.mockReturnValue(createLoadingSubagentTranscriptQuery());
});

afterEach(() => {
  cleanupSubagentTabTestEnvironment();
  vi.clearAllMocks();
});

describe('WorkspaceDetailPage', () => {
  it('does not render or query a persisted sub-agent tab from the previous workspace', async () => {
    seedSubagentTab(FIRST_WORKSPACE_ID, firstWorkspaceSelection);
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
