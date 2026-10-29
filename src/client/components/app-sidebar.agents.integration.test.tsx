// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { observable } from '@trpc/server/observable';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Link, MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { useAppNavigationData } from '@/client/hooks/use-app-navigation-data';
import { SELECTED_PROJECT_KEY } from '@/client/lib/project-selection';
import { trpc } from '@/client/lib/trpc';
import { SidebarProvider } from '@/components/ui/sidebar';
import { waitForReact } from '@/test-utils/react-act';
import { AppSidebar } from './app-sidebar';

vi.mock('@/client/hooks/use-project-workspace-query', () => ({
  useProjectWorkspaceQuery: () => ({}),
}));
vi.mock('@/client/hooks/use-project-snapshot-sync', () => ({ useProjectSnapshotSync: vi.fn() }));
vi.mock('@/client/hooks/use-workspace-attention', () => ({
  useWorkspaceAttention: () => ({ needsAttention: () => false, clearAttention: vi.fn() }),
}));
vi.mock('@/client/hooks/use-project-issues', () => ({ useProjectIssues: () => ({ issues: [] }) }));
vi.mock('@/hooks/use-mobile', () => ({ MOBILE_BREAKPOINT: 768, useIsMobile: () => false }));
vi.mock('./theme-toggle', () => ({ ThemeToggle: () => null }));
const alpha = { id: 'alpha', slug: 'alpha', name: 'Alpha' };
const beta = { id: 'beta', slug: 'space here', name: 'Beta', isArchived: true };
type Summary = { totalCount: number; failedCount: number };
let summaries: Record<string, Summary | Promise<Summary>>;
let ownerWait: Promise<void> | undefined;
let failSummary: boolean;
let requests: Array<{ path: string; input: unknown }>;
let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
function Harness() {
  const navigation = useAppNavigationData();
  return (
    <SidebarProvider>
      <Link to="/PROJECTS/space%20here/agents">Switch project</Link>
      <Link to="/projects/alpha/agents">Back to Alpha</Link>
      <AppSidebar navData={navigation} />
    </SidebarProvider>
  );
}
async function respond(path: string, input: unknown) {
  if (path === 'project.list') {
    return [alpha];
  }
  if (path === 'project.getBySlug') {
    await ownerWait;
    const { slug } = z.object({ slug: z.string() }).parse(input);
    return [alpha, beta].find((project) => project.slug === slug) ?? null;
  }
  if (path === 'periodicTask.navigationSummary') {
    if (failSummary) {
      throw new Error('Offline');
    }
    return summaries[z.object({ projectId: z.string() }).parse(input).projectId];
  }
  return {};
}
async function render(path = '/projects/alpha/agents') {
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            requests.push({ path: op.path, input: op.input });
            void respond(op.path, op.input).then(
              (data) => {
                observer.next({ result: { data } });
                observer.complete();
              },
              (error) => observer.error(error)
            );
          }),
    ],
  });
  await act(() =>
    root.render(
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[path]}>
            <Harness />
          </MemoryRouter>
        </QueryClientProvider>
      </trpc.Provider>
    )
  );
}
function agentsLink() {
  const link = [...container.querySelectorAll('a')].find((node) =>
    node.textContent?.startsWith('Agents')
  );
  if (!link) {
    throw new Error('Missing Agents link');
  }
  return link;
}
function description() {
  const id = agentsLink().getAttribute('aria-describedby');
  return id ? document.getElementById(id)?.textContent : null;
}
async function switchProject(label = 'Switch project') {
  await act(() =>
    [...container.querySelectorAll('a')]
      .find((link) => link.textContent === label)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, cancelable: true }))
  );
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.setItem(SELECTED_PROJECT_KEY, 'alpha');
  window.history.replaceState({}, '', '/');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  requests = [];
  ownerWait = undefined;
  failSummary = false;
  summaries = { alpha: { totalCount: 3, failedCount: 1 }, beta: { totalCount: 0, failedCount: 0 } };
});
afterEach(async () => {
  await act(() => root.unmount());
  queryClient.clear();
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});
it('shows the count and failure description, then clears the error after a successful refresh', async () => {
  await render();
  await waitForReact(() =>
    expect(description()).toBe('3 agents, 1 with a failed last completed run')
  );
  expect(agentsLink().getAttribute('aria-label')).toBe('Agents');
  expect(agentsLink().querySelector('[data-agent-count]')?.textContent).toBe('3');
  expect(agentsLink().querySelector('[data-agent-count]')?.className).toContain('text-destructive');
  summaries.alpha = { totalCount: 3, failedCount: 0 };
  await act(() =>
    queryClient.invalidateQueries({
      queryKey: getQueryKey(trpc.periodicTask.navigationSummary, { projectId: 'alpha' }, 'query'),
    })
  );
  await waitForReact(() => expect(description()).toBe('3 agents'));
  expect(agentsLink().querySelector('[data-agent-count]')?.className).not.toContain(
    'text-destructive'
  );
});
it('keeps the last successful same-project count on a refresh error, and hides an initial error', async () => {
  await render();
  await waitForReact(() => expect(description()).toContain('3 agents'));
  failSummary = true;
  await act(() =>
    queryClient.invalidateQueries({ queryKey: getQueryKey(trpc.periodicTask.navigationSummary) })
  );
  expect(description()).toContain('3 agents');
  await switchProject();
  await waitForReact(() =>
    expect(agentsLink().getAttribute('href')).toBe('/projects/space%20here/agents')
  );
  expect(description()).toBeNull();
  expect(agentsLink().querySelector('[data-agent-count]')).toBeNull();
});
it('hides loading counts and scopes the decoded archived URL owner before stored selection', async () => {
  const owner = deferred<void>();
  ownerWait = owner.promise;
  const result = deferred<Summary>();
  summaries.beta = result.promise;
  await render('/PROJECTS/space%20here/agents');
  expect(description()).toBeNull();
  expect(requests.some((request) => request.path === 'periodicTask.navigationSummary')).toBe(false);
  await act(() => owner.resolve());
  await waitForReact(() =>
    expect(requests).toContainEqual({
      path: 'periodicTask.navigationSummary',
      input: { projectId: 'beta' },
    })
  );
  expect(requests).not.toContainEqual({
    path: 'periodicTask.navigationSummary',
    input: { projectId: 'alpha' },
  });
  expect(description()).toBeNull();
  await act(() => result.resolve({ totalCount: 0, failedCount: 0 }));
  await waitForReact(() => expect(description()).toBe('0 agents'));
  expect(agentsLink().querySelector('[data-agent-count]')?.textContent).toBe('0');
});
it('does not borrow a loaded count or accept a late refresh after switching projects', async () => {
  await render();
  await waitForReact(() => expect(description()).toContain('3 agents'));
  const lateAlpha = deferred<Summary>();
  summaries.alpha = lateAlpha.promise;
  await act(() => {
    void queryClient.invalidateQueries({
      queryKey: getQueryKey(trpc.periodicTask.navigationSummary, { projectId: 'alpha' }, 'query'),
    });
  });
  await waitForReact(() =>
    expect(
      requests.filter((request) => request.path === 'periodicTask.navigationSummary')
    ).toHaveLength(2)
  );
  expect(description()).toContain('3 agents');
  const owner = deferred<void>();
  ownerWait = owner.promise;
  const betaResult = deferred<Summary>();
  summaries.beta = betaResult.promise;
  await switchProject();
  expect(description()).toBeNull();
  await act(() => owner.resolve());
  await waitForReact(() =>
    expect(requests).toContainEqual({
      path: 'periodicTask.navigationSummary',
      input: { projectId: 'beta' },
    })
  );
  expect(description()).toBeNull();
  await act(() => lateAlpha.resolve({ totalCount: 99, failedCount: 99 }));
  expect(description()).toBeNull();
  await act(() => betaResult.resolve({ totalCount: 2, failedCount: 0 }));
  await waitForReact(() => expect(description()).toBe('2 agents'));
});
