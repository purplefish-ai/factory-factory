// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PeriodicTaskPanel } from './periodic-task-panel';

const mocks = vi.hoisted(() => ({
  task: {
    data: undefined as unknown,
    isLoading: false,
    error: null as null | { message: string; data?: { code: string } },
    refetch: vi.fn(),
  },
  project: {
    data: undefined as unknown,
    isLoading: false,
    error: null as null | { message: string },
    refetch: vi.fn(),
  },
  history: {
    data: [] as unknown[],
    isLoading: false,
    error: null as null | { message: string },
    refetch: vi.fn(),
  },
  projectInput: vi.fn(),
  historyInput: vi.fn(),
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    periodicTask: {
      get: { useQuery: () => mocks.task },
      listExecutions: {
        useQuery: (input: unknown) => {
          mocks.historyInput(input);
          return mocks.history;
        },
      },
    },
    project: {
      getById: {
        useQuery: (input: unknown) => {
          mocks.projectInput(input);
          return mocks.project;
        },
      },
    },
  },
}));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.task.data = {
    id: 'agent-1',
    projectId: 'owner',
    name: 'Review changes',
    prompt: 'Review carefully',
    cadence: 'DAILY',
    scheduledTime: '09:00',
    timezone: 'America/New_York',
    isEnabled: true,
    lastRunAt: null,
    nextRunAt: new Date('2026-01-13T14:00:00Z'),
  };
  mocks.task.error = null;
  mocks.task.isLoading = false;
  mocks.project.data = { id: 'owner', slug: 'archived-owner', name: 'Owner' };
  mocks.project.error = null;
  mocks.history.data = [
    {
      id: 'run-1',
      status: 'PR_CREATED',
      workspaceId: 'archived-workspace',
      prUrl: 'https://github.com/example/repo/pull/1',
      prNumber: 1,
      errorMessage: null,
      startedAt: new Date('2026-01-12T12:00:00Z'),
      completedAt: null,
    },
  ];
  mocks.history.error = null;
  mocks.history.isLoading = false;
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      <MemoryRouter>
        <PeriodicTaskPanel periodicTaskId="agent-1" />
      </MemoryRouter>
    )
  );
  return { container, dispose: () => act(() => root.unmount()) };
}
it('links to Agent management and shared history using the agent owner, including archived workspaces', async () => {
  const view = await render();
  try {
    expect(view.container.querySelector('a[href="/agents/agent-1"]')?.textContent).toContain(
      'Manage Agent'
    );
    expect(mocks.projectInput).toHaveBeenCalledWith({ id: 'owner' });
    expect(mocks.historyInput).toHaveBeenCalledWith({ periodicTaskId: 'agent-1', limit: 50 });
    expect(view.container.textContent).toContain('Up to 50 recent runs');
    expect(view.container.textContent).toContain('America/New_York');
    expect(view.container.textContent).toContain('Next run:');
    expect(
      view.container.querySelector(
        'a[href="/projects/archived-owner/workspaces/archived-workspace"]'
      )
    ).not.toBeNull();
  } finally {
    await view.dispose();
  }
});
it.each(['loading', 'NOT_FOUND', 'network'])('shows explicit %s agent state', async (state) => {
  mocks.task.data = undefined;
  mocks.task.isLoading = state === 'loading';
  mocks.task.error = state === 'loading' ? null : { message: 'Read failed', data: { code: state } };
  const view = await render();
  try {
    expect(view.container.textContent).toContain(
      state === 'loading'
        ? 'Loading agent'
        : state === 'NOT_FOUND'
          ? 'Agent not found'
          : 'Read failed'
    );
    if (state !== 'loading') {
      const retry = [...view.container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Retry agent'
      );
      await act(() => retry?.click());
      expect(mocks.task.refetch).toHaveBeenCalledOnce();
    }
  } finally {
    await view.dispose();
  }
});
it('shows run-history failures and retries instead of presenting empty history', async () => {
  mocks.history.error = { message: 'History unavailable' };
  mocks.history.data = [];
  const view = await render();
  try {
    expect(view.container.textContent).toContain('History unavailable');
    expect(view.container.textContent).not.toContain('No runs yet');
    await act(() =>
      [...view.container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Retry run history')
        ?.click()
    );
    expect(mocks.history.refetch).toHaveBeenCalledOnce();
  } finally {
    await view.dispose();
  }
});

it('retains cached agent details and allows retrying a failed definition refresh', async () => {
  mocks.task.error = { message: 'Definition refresh unavailable' };
  const view = await render();
  try {
    expect(view.container.textContent).toContain('Review changes');
    expect(view.container.textContent).toContain(
      'Could not refresh agent: Definition refresh unavailable'
    );
    const retry = [...view.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry agent'
    );
    expect(retry).toBeDefined();
    await act(() => retry?.click());
    expect(mocks.task.refetch).toHaveBeenCalledOnce();
    expect(view.container.querySelector('a[href="/agents/agent-1"]')).not.toBeNull();
  } finally {
    await view.dispose();
  }
});
