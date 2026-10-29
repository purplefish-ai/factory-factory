// @vitest-environment jsdom

import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { CircleIcon } from '@phosphor-icons/react/dist/csr/Circle';
import { ProhibitIcon } from '@phosphor-icons/react/dist/csr/Prohibit';
import { PulseIcon } from '@phosphor-icons/react/dist/csr/Pulse';
import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import { SpinnerGapIcon } from '@phosphor-icons/react/dist/csr/SpinnerGap';
import { XCircleIcon } from '@phosphor-icons/react/dist/csr/XCircle';
import { composeStories } from '@storybook/react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { within } from 'storybook/test';
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
import type { WorkspaceSessionRuntimeSummary } from './session-tab-runtime';
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
        <MainViewTabBar workspaceId={workspaceId} sessions={[]} />
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

it('shows a plain new-session button without launch pickers', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onCreateSession = vi.fn();
  try {
    await act(() =>
      root.render(
        <TooltipProvider>
          <WorkspacePanelProvider workspaceId="plain-create">
            <MainViewTabBar
              workspaceId="plain-create"
              sessions={[]}
              onCreateSession={onCreateSession}
            />
          </WorkspacePanelProvider>
        </TooltipProvider>
      )
    );
    expect(container.querySelector('[aria-label^="New conversation provider"]')).toBeNull();
    const create = container.querySelector<HTMLButtonElement>('[aria-label="New session"]');
    expect(create?.disabled).toBe(false);
    await act(() => create?.click());
    expect(onCreateSession).toHaveBeenCalledOnce();
  } finally {
    await act(() => root.unmount());
  }
});

it('disables the new-session button until sessions load', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <TooltipProvider>
          <WorkspacePanelProvider workspaceId="loading-create">
            <MainViewTabBar
              workspaceId="loading-create"
              sessions={undefined}
              onCreateSession={vi.fn()}
            />
          </WorkspacePanelProvider>
        </TooltipProvider>
      )
    );
    expect(container.querySelector<HTMLButtonElement>('[aria-label="New session"]')?.disabled).toBe(
      true
    );
  } finally {
    await act(() => root.unmount());
  }
});

it('labels only legacy agent defaults and keeps agent identity with runtime status', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const sessions = [
    { id: 'legacy', name: 'Periodic task', workflow: 'periodic-task', status: 'RUNNING' as const },
    {
      id: 'custom',
      name: 'Dependency review',
      workflow: 'periodic-task',
      status: 'FAILED' as const,
    },
    { id: 'ordinary', name: 'Periodic task', workflow: null, status: 'IDLE' as const },
  ];
  try {
    await act(() =>
      root.render(
        <TooltipProvider>
          <WorkspacePanelProvider workspaceId="agent-identity">
            <MainViewTabBar workspaceId="agent-identity" sessions={sessions} />
          </WorkspacePanelProvider>
        </TooltipProvider>
      )
    );
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs[0]?.textContent).toBe('Agent');
    expect(tabs[1]?.textContent).toBe('Dependency review');
    expect(tabs[2]?.textContent).toBe('Periodic task');
    expect(
      tabs[0]?.querySelector('[aria-label="Agent: Running"]')?.classList.contains('text-brand')
    ).toBe(true);
    expect(
      tabs[1]?.querySelector('[aria-label="Agent: Failed"]')?.classList.contains('text-destructive')
    ).toBe(true);
    expect(tabs[2]?.querySelector('[aria-label^="Agent:"]')).toBeNull();
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

it.each([
  ['IDLE', 'Idle', CircleIcon],
  ['RUNNING', 'Running', PulseIcon],
  ['PAUSED', 'Paused', ProhibitIcon],
  ['COMPLETED', 'Completed', CheckCircleIcon],
  ['FAILED', 'Failed', XCircleIcon],
  ['loading', 'Loading', SpinnerGapIcon],
  ['starting', 'Starting', SpinnerGapIcon],
] as const)(
  'keeps robot identity and a distinct %s marker in workspace tabs',
  async (state, label, Icon) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const expected = document.createElement('div');
    expected.innerHTML = renderToStaticMarkup(
      <>
        <RobotIcon />
        <Icon />
      </>
    );
    const runtime: WorkspaceSessionRuntimeSummary | undefined =
      state === 'loading' || state === 'starting'
        ? {
            sessionId: 'agent',
            name: 'Custom agent',
            workflow: 'periodic-task',
            model: 'sonnet',
            persistedStatus: 'IDLE',
            runtimePhase: state,
            processState: 'alive',
            activity: 'IDLE',
            updatedAt: '2026-10-29T00:00:00Z',
            lastExit: null,
          }
        : undefined;
    try {
      await act(() =>
        root.render(
          <TooltipProvider>
            <WorkspacePanelProvider workspaceId={`agent-${state}`}>
              <MainViewTabBar
                workspaceId={`agent-${state}`}
                sessions={[
                  {
                    id: 'agent',
                    name: 'Custom agent',
                    workflow: 'periodic-task',
                    status: state === 'loading' || state === 'starting' ? 'IDLE' : state,
                  },
                ]}
                sessionSummariesById={runtime ? new Map([['agent', runtime]]) : undefined}
              />
            </WorkspacePanelProvider>
          </TooltipProvider>
        )
      );
      const identity = within(container).getByRole('img', { name: `Agent: ${label}` });
      const icons = identity.querySelectorAll('svg');
      expect(icons).toHaveLength(2);
      expect(icons[0]?.innerHTML).toBe(expected.querySelectorAll('svg')[0]?.innerHTML);
      expect(icons[1]?.innerHTML).toBe(expected.querySelectorAll('svg')[1]?.innerHTML);
      expect(icons[1]?.classList.contains('animate-spin')).toBe(
        state === 'loading' || state === 'starting'
      );
      expect(container.querySelector('[role="tab"]')?.textContent).toBe('Custom agent');
    } finally {
      await act(() => root.unmount());
      container.remove();
    }
  }
);
