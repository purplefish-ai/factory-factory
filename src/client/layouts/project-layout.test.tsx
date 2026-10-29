// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { getQueryKey } from '@trpc/react-query';
import { observable } from '@trpc/server/observable';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppHeaderProvider } from '@/client/components/app-header-context';
import type { Agent } from '@/client/features/agents/types';
import { trpc } from '@/client/lib/trpc';
import AgentsRoute from '@/client/routes/agents/index';
import { actFlushSync, waitForReact } from '@/test-utils/react-act';
import { ProjectLayout } from './project-layout';

const projects = [
  { id: 'alpha-id', slug: 'alpha', name: 'Alpha' },
  { id: 'beta-id', slug: 'beta', name: 'Beta' },
];
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/client/hooks/use-app-navigation-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/client/hooks/use-app-navigation-data')>()),
  useAppNavigationDataContext: () => ({
    projects,
    selectedProjectSlug: 'alpha',
    selectProjectSlug: vi.fn(),
  }),
}));
const agent: Agent = {
  id: 'agent',
  projectId: 'alpha-id',
  name: 'Scheduled review',
  prompt: 'Find important bugs',
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
const projectRead = vi.fn<(slug: string) => Promise<unknown>>();
let cleanup: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  projectRead
    .mockReset()
    .mockImplementation(async (slug) => projects.find((project) => project.slug === slug));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
});
function notFound() {
  return new TRPCClientError('Missing project', {
    result: {
      error: {
        message: 'Missing project',
        code: -32_004,
        data: { code: 'NOT_FOUND', httpStatus: 404 },
      },
    },
  });
}
function requestResult(path: string, input: unknown): Promise<unknown> {
  switch (path) {
    case 'project.getBySlug':
      return projectRead(z.object({ slug: z.string() }).parse(input).slug);
    case 'periodicTask.get':
      return Promise.resolve(agent);
    case 'periodicTask.list': {
      const { projectId } = z.object({ projectId: z.string() }).parse(input);
      return Promise.resolve(projectId === agent.projectId ? [agent] : []);
    }
    case 'periodicTask.listExecutions':
      return Promise.resolve([]);
    default:
      return Promise.reject(new Error(`Unexpected request ${path}`));
  }
}
function render() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            void requestResult(op.path, op.input).then(
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
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  actFlushSync(() =>
    root.render(
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <AppHeaderProvider>
            <MemoryRouter initialEntries={['/projects/alpha/agents/agent']}>
              <Link to="/projects/beta/agents">Switch project</Link>
              <Routes>
                <Route path="/projects/:slug" element={<ProjectLayout />}>
                  <Route path="agents/:id?" element={<AgentsRoute />} />
                </Route>
              </Routes>
            </MemoryRouter>
          </AppHeaderProvider>
        </QueryClientProvider>
      </trpc.Provider>
    )
  );
  cleanup = () => {
    actFlushSync(() => root.unmount());
    queryClient.clear();
    container.remove();
  };
  return { container, queryClient };
}
function button(container: HTMLElement, label: string) {
  const match = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label
  );
  expect(match, `Missing button ${label}`).toBeDefined();
  return match!;
}
async function editDraft(container: HTMLElement) {
  await waitForReact(() => expect(container.textContent).toContain('Edit Agent'));
  actFlushSync(() => button(container, 'Edit Agent').click());
  const input = container.querySelector<HTMLInputElement>('input[name="name"]');
  expect(input).not.toBeNull();
  actFlushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      'Unsaved canonical draft'
    );
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input!;
}
it('preserves the actual canonical Agent editor and draft through background project failure and retry', async () => {
  const { container, queryClient } = render();
  const input = await editDraft(container);
  projectRead.mockRejectedValue(new Error('Project connection lost'));
  const key = getQueryKey(trpc.project.getBySlug, { slug: 'alpha' }, 'query');
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: key });
  });
  await waitForReact(() => expect(queryClient.getQueryState(key)?.status).toBe('error'));
  expect(container.querySelector('input[name="name"]')).toBe(input);
  expect(input.value).toBe('Unsaved canonical draft');
  await waitForReact(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Project connection lost'
    )
  );
  let resolveRetry: ((value: unknown) => void) | undefined;
  projectRead.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveRetry = resolve;
      })
  );
  actFlushSync(() => button(container, 'Retry project').click());
  expect(container.querySelector('input[name="name"]')).toBe(input);
  expect(input.value).toBe('Unsaved canonical draft');
  await act(async () => resolveRetry?.(projects[0]));
  await waitForReact(() => expect(container.querySelector('[role="alert"]')).toBeNull());
  expect(container.querySelector('input[name="name"]')).toBe(input);
  expect(input.value).toBe('Unsaved canonical draft');
});
it('distinguishes first-load transport failure and retries the real outlet', async () => {
  projectRead.mockRejectedValue(new Error('Network offline'));
  const { container } = render();
  await waitForReact(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Network offline')
  );
  expect(container.textContent).not.toContain('Project not found');
  expect(container.textContent).not.toContain('Scheduled review');
  projectRead.mockResolvedValue(projects[0]);
  actFlushSync(() => button(container, 'Retry project').click());
  await waitForReact(() => expect(container.textContent).toContain('Edit Agent'));
});
it('reports actual first-load NOT_FOUND without exposing an Agent editor', async () => {
  projectRead.mockRejectedValue(notFound());
  const { container } = render();
  await waitForReact(() => expect(container.textContent).toContain('Project not found'));
  expect(container.textContent).not.toContain('Could not load project');
  expect(container.querySelector('input[name="name"]')).toBeNull();
});
it('does not keep a deleted project outlet merely because cached data exists', async () => {
  const { container, queryClient } = render();
  await editDraft(container);
  projectRead.mockRejectedValue(notFound());
  await act(async () => {
    await queryClient.refetchQueries({
      queryKey: getQueryKey(trpc.project.getBySlug, { slug: 'alpha' }, 'query'),
    });
  });
  await waitForReact(() => expect(container.textContent).toContain('Project not found'));
  expect(container.querySelector('input[name="name"]')).toBeNull();
});
it('does not retain the prior project draft while a different owner is loading', async () => {
  const { container } = render();
  await editDraft(container);
  let resolveProject: ((value: unknown) => void) | undefined;
  projectRead.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveProject = resolve;
      })
  );
  actFlushSync(() =>
    container.querySelector<HTMLAnchorElement>('a[href="/projects/beta/agents"]')?.click()
  );
  expect(container.querySelector('input[name="name"]')).toBeNull();
  expect(container.textContent).not.toContain('Scheduled review');
  await act(async () => resolveProject?.(projects[1]));
  await waitForReact(() => expect(container.textContent).toContain('Give recurring work an agent'));
});
