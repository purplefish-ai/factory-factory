// @vitest-environment jsdom

import { composeStories } from '@storybook/react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentSelection } from '@/client/features/subagents';
import { MainViewTabBar } from './main-view-tab-bar';
import * as tabBarStories from './main-view-tab-bar.stories';
import { WorkspacePanelProvider } from './workspace-panel-context';

const { RunningSubagent } = composeStories(tabBarStories);

const mocks = vi.hoisted<{
  listRefetch: ReturnType<typeof vi.fn>;
  summary: SubagentSelection['subagent'];
}>(() => ({
  listRefetch: vi.fn(() => Promise.resolve()),
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
        useQuery: () => ({
          data: {
            supported: true,
            subagents: [mocks.summary],
            nextCursor: null,
          },
          refetch: mocks.listRefetch,
        }),
      },
    },
  },
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});

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

function subagentTabId(selection: SubagentSelection): string {
  return `subagent-${selection.parentSessionId}-${selection.subagent.id}`;
}

function seedSubagentTab(
  workspaceId: string,
  selection: SubagentSelection,
  activeTabId = subagentTabId(selection)
) {
  localStorage.setItem(
    `workspace-panel-tabs-${workspaceId}`,
    JSON.stringify([
      { id: 'chat', type: 'chat', label: 'Chat' },
      {
        id: subagentTabId(selection),
        type: 'subagent',
        label: selection.subagent.name,
        subagentSelection: selection,
      },
    ])
  );
  localStorage.setItem(`workspace-panel-active-tab-${workspaceId}`, activeTabId);
}

async function renderTabBar(workspaceId: string) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => {
    root.render(
      <WorkspacePanelProvider workspaceId={workspaceId}>
        <MainViewTabBar
          workspaceId={workspaceId}
          sessions={[]}
          selectedProvider="CODEX"
          setSelectedProvider={vi.fn()}
        />
      </WorkspacePanelProvider>
    );
  });
  return { container, root };
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  mocks.listRefetch.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
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
