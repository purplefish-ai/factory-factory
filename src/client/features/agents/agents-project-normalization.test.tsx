// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AppNavigationDataProvider,
  useAppNavigationData,
} from '@/client/hooks/use-app-navigation-data';
import { SELECTED_PROJECT_KEY } from '@/client/lib/project-selection';
import { trpc } from '@/client/lib/trpc';
import { actFlushSync, waitForReact } from '@/test-utils/react-act';
import { AgentsPage } from './agents-page';
import type { Agent } from './types';

// Keep real navigation state/normalization; unrelated workspace subscriptions
// do not participate in the project-list/task-get race being exercised.
vi.mock('@/client/hooks/use-project-workspace-query', () => ({
  useProjectWorkspaceQuery: () => ({ data: undefined }),
}));
vi.mock('@/client/hooks/use-project-snapshot-sync', () => ({ useProjectSnapshotSync: vi.fn() }));
vi.mock('@/client/hooks/use-workspace-attention', () => ({
  useWorkspaceAttention: () => ({ needsAttention: () => false, clearAttention: vi.fn() }),
}));

const projects = [
  { id: 'first', slug: 'first-active', name: 'First active project', issueProvider: 'GITHUB' },
  { id: 'owner', slug: 'owner-project', name: 'Owner project', issueProvider: 'GITHUB' },
];
const agent: Agent = {
  id: 'requested-agent',
  projectId: 'owner',
  name: 'Requested agent',
  prompt: 'Review changes',
  cadence: 'DAILY',
  scheduledTime: null,
  timezone: null,
  scheduledDayOfMonth: null,
  isEnabled: true,
  nextRunAt: new Date(),
  lastRunAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  executions: [],
};
let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
let finishTask: () => void;
let taskWait: Promise<void>;
function RealNavigationHarness() {
  const navigation = useAppNavigationData();
  const { pathname } = useLocation();
  return (
    <AppNavigationDataProvider value={navigation}>
      <AgentsPage />
      <output aria-label="Current route">{pathname}</output>
      <output aria-label="Selected project">{navigation.selectedProjectSlug}</output>
    </AppNavigationDataProvider>
  );
}
async function response(path: string, requestedId: string) {
  if (path === 'project.list') {
    return projects;
  }
  if (path === 'periodicTask.get') {
    await taskWait;
    if (requestedId === 'missing-agent') {
      throw new TRPCClientError('Agent does not exist', {
        result: {
          error: {
            message: 'Agent does not exist',
            code: -32_004,
            data: { code: 'NOT_FOUND', httpStatus: 404 },
          },
        },
      });
    }
    return agent;
  }
  if (path === 'periodicTask.list' || path === 'periodicTask.listExecutions') {
    return [];
  }
  return { success: true };
}
function render(requestedId: string, persistedSlug: string) {
  localStorage.setItem(SELECTED_PROJECT_KEY, persistedSlug);
  window.history.replaceState({}, '', `/agents/${requestedId}`);
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            void response(op.path, requestedId).then(
              (data) => {
                observer.next({ result: { data } });
                observer.complete();
              },
              (error: unknown) =>
                observer.error(
                  TRPCClientError.from(error instanceof Error ? error : new Error(String(error)))
                )
            );
          }),
    ],
  });
  actFlushSync(() =>
    root.render(
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[`/agents/${requestedId}`]}>
            <Routes>
              <Route path="/agents/:id?" element={<RealNavigationHarness />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </trpc.Provider>
    )
  );
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  taskWait = new Promise<void>((resolve) => {
    finishTask = resolve;
  });
});
afterEach(() => {
  actFlushSync(() => root.unmount());
  queryClient.clear();
  container.remove();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});

describe('explicit agent links during real project normalization', () => {
  it.each(['removed-project', 'archived-project'])(
    'preserves a delayed task ID when persisted %s normalizes to the first active project',
    async (persistedSlug) => {
      render(agent.id, persistedSlug);
      await waitForReact(() =>
        expect(container.querySelector('output[aria-label="Selected project"]')?.textContent).toBe(
          'first-active'
        )
      );
      expect(container.querySelector('output[aria-label="Current route"]')?.textContent).toBe(
        '/agents/requested-agent'
      );
      await act(async () => {
        finishTask();
        await taskWait;
      });
      await waitForReact(() =>
        expect(container.querySelector('h2')?.textContent).toBe('Requested agent')
      );
      expect(container.querySelector('output[aria-label="Selected project"]')?.textContent).toBe(
        'owner-project'
      );
      expect(container.querySelector('output[aria-label="Current route"]')?.textContent).toBe(
        '/agents/requested-agent'
      );
    }
  );
  it('navigates inside Agents when the user explicitly changes the project filter', async () => {
    render(agent.id, 'removed-project');
    await act(async () => {
      finishTask();
      await taskWait;
    });
    await waitForReact(() =>
      expect(container.querySelector('h2')?.textContent).toBe('Requested agent')
    );
    actFlushSync(() =>
      container
        .querySelector('[role="combobox"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    );
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (candidate) => candidate.textContent === 'First active project'
    );
    expect(option).toBeDefined();
    actFlushSync(() => option?.click());
    await waitForReact(() =>
      expect(container.querySelector('output[aria-label="Current route"]')?.textContent).toBe(
        '/agents'
      )
    );
    expect(container.querySelector('output[aria-label="Selected project"]')?.textContent).toBe(
      'first-active'
    );
  });
  it('keeps a delayed missing task ID and displays not found after normalization', async () => {
    render('missing-agent', 'removed-project');
    await waitForReact(() =>
      expect(container.querySelector('output[aria-label="Selected project"]')?.textContent).toBe(
        'first-active'
      )
    );
    await act(async () => {
      finishTask();
      await taskWait;
    });
    await waitForReact(() => expect(container.textContent).toContain('Agent not found'));
    expect(container.querySelector('output[aria-label="Current route"]')?.textContent).toBe(
      '/agents/missing-agent'
    );
  });
});
