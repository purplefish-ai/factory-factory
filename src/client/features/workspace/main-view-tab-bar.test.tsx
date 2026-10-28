// @vitest-environment jsdom

import { composeStories } from '@storybook/react';
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentSelection } from '@/client/features/subagents';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  cleanupSubagentTabTestEnvironment,
  seedSubagentTab,
  setupSubagentTabTestEnvironment,
} from '@/test-utils/subagent-tabs';
import { MainViewTabBar } from './main-view-tab-bar';
import * as tabBarStories from './main-view-tab-bar.stories';
import { WorkspacePanelProvider } from './workspace-panel-context';

const { RunningSubagent } = composeStories(tabBarStories);

const mocks = vi.hoisted<{
  listRefetch: ReturnType<typeof vi.fn>;
  summary: SubagentSelection['subagent'];
}>(() => ({
  listRefetch: vi.fn(() =>
    Promise.resolve({ data: undefined, dataUpdatedAt: 0, isSuccess: false })
  ),
  summary: {
    id: 'child-1',
    name: 'Security review',
    status: 'running',
    createdAt: '2026-08-10T10:00:00.000Z',
    updatedAt: '2026-08-10T10:01:00.000Z',
    completedAt: null,
    latestActivity: 'Inspecting auth',
    resultPreview: null,
  },
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    session: {
      listSubagents: {
        useInfiniteQuery: () => ({
          data: {
            pages: [
              {
                supported: true,
                subagents: [mocks.summary],
                nextCursor: null,
              },
            ],
            pageParams: [null],
          },
          fetchNextPage: vi.fn(() => Promise.resolve()),
          hasNextPage: false,
          isFetchingNextPage: false,
          isFetchNextPageError: false,
          refetch: mocks.listRefetch,
        }),
      },
    },
  },
}));

const runningSelection: SubagentSelection = {
  parentSessionId: 'session-1',
  parentSessionName: 'Chat 1',
  subagent: {
    id: 'child-1',
    name: 'Security review',
    status: 'running',
    createdAt: '2026-08-10T10:00:00.000Z',
    updatedAt: '2026-08-10T10:01:00.000Z',
    completedAt: null,
    latestActivity: 'Inspecting auth',
    resultPreview: null,
  },
};

async function renderTabBar(workspaceId: string) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => {
    root.render(
      <WorkspacePanelProvider workspaceId={workspaceId}>
        <MainViewTabBar workspaceId={workspaceId} sessions={[]} selectedProvider="CODEX" />
      </WorkspacePanelProvider>
    );
  });
  return { container, root };
}

beforeEach(() => {
  setupSubagentTabTestEnvironment();
  mocks.summary = { ...runningSelection.subagent };
  mocks.listRefetch.mockClear();
});

afterEach(() => {
  cleanupSubagentTabTestEnvironment();
});

describe('MainViewTabBar sub-agent tabs', () => {
  it.each([
    ['starting', 'text-blue-500', true],
    ['running', 'text-blue-500', true],
    ['waiting', 'text-amber-500', false],
    ['completed', 'text-green-500', false],
    ['failed', 'text-destructive', false],
    ['cancelled', 'text-muted-foreground', false],
    ['interrupted', 'text-muted-foreground', false],
  ] as const)('shows a %s robot for a sub-agent tab', async (status, color, pulses) => {
    const selection: SubagentSelection = {
      ...runningSelection,
      subagent: { ...runningSelection.subagent, status },
    };
    mocks.summary = { ...selection.subagent };
    const workspaceId = `workspace-${status}`;
    seedSubagentTab(workspaceId, selection);
    const { container, root } = await renderTabBar(workspaceId);

    await vi.waitFor(() => {
      const tab = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((candidate) =>
        candidate.textContent?.includes('Security review')
      );
      const robot = tab?.querySelector<SVGElement>(`svg[aria-label="${status} sub-agent"]`);
      expect(robot?.classList.contains(color)).toBe(true);
      expect(robot?.classList.contains('animate-pulse')).toBe(pulses);
      expect(robot?.classList.contains('motion-reduce:animate-none')).toBe(pulses);
      expect(tab?.querySelector('button[aria-label="Close Security review"]')).not.toBeNull();
    });

    await act(() => root.unmount());
  });

  it('refreshes and persists the status of an inactive sub-agent tab', async () => {
    const workspaceId = 'workspace-provider-refresh';
    seedSubagentTab(workspaceId, runningSelection, 'chat');
    mocks.summary = {
      ...runningSelection.subagent,
      status: 'completed',
      completedAt: '2026-08-10T10:05:00.000Z',
    };
    const { container, root } = await renderTabBar(workspaceId);

    await vi.waitFor(() => {
      const robot = container.querySelector<SVGElement>('svg[aria-label="completed sub-agent"]');
      expect(robot?.classList.contains('text-green-500')).toBe(true);
      const stored = JSON.parse(
        localStorage.getItem(`workspace-panel-tabs-${workspaceId}`) ?? '[]'
      );
      expect(stored[1].subagentSelection.subagent.status).toBe('completed');
    });

    await act(() => root.unmount());
  });

  it('opens the sub-agent tab in the hydrated running story', async () => {
    mocks.summary = { ...runningSelection.subagent };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(() => root.render(<RunningSubagent />));

    await vi.waitFor(() => {
      expect(container.querySelector('svg[aria-label="running sub-agent"]')).not.toBeNull();
    });
    await act(() => root.unmount());
  });
});

describe('MainViewTabBar session creation', () => {
  async function renderCreationBar(props: Partial<ComponentProps<typeof MainViewTabBar>> = {}) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onCreateSession = vi.fn();
    await act(() =>
      root.render(
        <TooltipProvider>
          <WorkspacePanelProvider workspaceId="creation">
            <MainViewTabBar
              workspaceId="creation"
              sessions={[{ id: 'current', name: 'Chat 1', status: 'RUNNING' }]}
              selectedProvider="CODEX"
              onCreateSession={onCreateSession}
              {...props}
            />
          </WorkspacePanelProvider>
        </TooltipProvider>
      )
    );
    return { container, root, onCreateSession };
  }

  it('offers just the plus button and creates a session on click', async () => {
    const { container, root, onCreateSession } = await renderCreationBar();
    try {
      expect(container.querySelector('[aria-haspopup]')).toBeNull();
      expect(container.textContent).not.toContain('New');
      const create = container.querySelector<HTMLButtonElement>('[aria-label="New Codex session"]');
      expect(create?.disabled).toBe(false);
      await act(() => create?.click());
      expect(onCreateSession).toHaveBeenCalledOnce();
    } finally {
      await act(() => root.unmount());
    }
  });

  it('blocks creation while the selected session settings are loading', async () => {
    const { container, root, onCreateSession } = await renderCreationBar({
      selectedProvider: null,
      creationReady: false,
      creationUnavailableReason: 'Loading current session settings',
    });
    try {
      const create = container.querySelector<HTMLButtonElement>('[aria-label="New conversation"]');
      expect(create?.disabled).toBe(true);
      expect(create?.getAttribute('aria-description')).toBe('Loading current session settings');
      await act(() => create?.click());
      expect(onCreateSession).not.toHaveBeenCalled();
    } finally {
      await act(() => root.unmount());
    }
  });

  it('keeps the session limit enforced', async () => {
    const { container, root } = await renderCreationBar({ maxSessions: 1 });
    try {
      expect(
        container.querySelector<HTMLButtonElement>('[aria-label="New Codex session"]')?.disabled
      ).toBe(true);
    } finally {
      await act(() => root.unmount());
    }
  });
});
