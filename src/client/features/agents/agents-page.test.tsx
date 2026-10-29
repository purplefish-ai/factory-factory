// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { trpc } from '@/client/lib/trpc';
import { actFlushSync, waitForReact } from '@/test-utils/react-act';
import { AgentsPage } from './agents-page';
import type { Agent } from './types';

const navigation = vi.hoisted(
  (): {
    slug: string;
    setSlug: (slug: string) => void;
    setProjectsError: (error: Error | null) => void;
  } => ({ slug: 'stale', setSlug: vi.fn(), setProjectsError: vi.fn() })
);
const projects = [
  { id: 'stale', slug: 'stale', name: 'Other project' },
  { id: 'owner', slug: 'owner-slug', name: 'Owner project' },
];
vi.mock('@/client/hooks/use-app-navigation-data', () => ({
  useAppNavigationDataContext: () => {
    const [slug, setSlug] = useState(navigation.slug);
    navigation.setSlug = setSlug;
    const [projectsError, setProjectsError] = useState<Error | null>(null);
    navigation.setProjectsError = setProjectsError;
    return {
      projects,
      selectedProjectSlug: slug,
      selectProjectSlug: setSlug,
      refetchProjects: vi.fn(),
      projectsError,
    };
  },
}));

const task: Agent = {
  id: 'agent',
  projectId: 'owner',
  name: 'Review changes',
  prompt: 'Find bugs',
  cadence: 'DAILY',
  scheduledTime: '09:00',
  timezone: 'Asia/Tokyo',
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
let failMutation: string | null;
let failQuery: string | null;
let missing: boolean;
let archived: boolean;
let requests: { path: string; input: unknown }[];
let mutationWait: Promise<void> | undefined;
let removed: boolean;
let listWait: Promise<void> | undefined;
const notFound = () =>
  new TRPCClientError('Agent does not exist', {
    result: {
      error: {
        message: 'Agent does not exist',
        code: -32_004,
        data: { code: 'NOT_FOUND', httpStatus: 404 },
      },
    },
  });
function Location() {
  return <output aria-label="Location">{useLocation().pathname}</output>;
}
async function executeRequest(path: string, type: string, input: unknown) {
  if (type === 'mutation') {
    await mutationWait;
    if (failMutation === path) {
      throw new TRPCClientError('Server refused the change');
    }
  }
  if (failQuery === path) {
    throw new TRPCClientError('Connection unavailable');
  }
  return queryResponse(path, input);
}
function taskResponse(input: unknown) {
  if (missing || removed) {
    throw notFound();
  }
  const { id } = z.object({ id: z.string() }).parse(input);
  return { ...task, id, projectId: archived ? 'archived' : task.projectId };
}
async function queryResponse(path: string, input: unknown) {
  if (path === 'periodicTask.get') {
    return taskResponse(input);
  }
  if (path === 'project.getById') {
    return { id: 'archived', slug: 'archived-owner', name: 'Archived project' };
  }
  if (path === 'periodicTask.list') {
    if (removed) {
      await listWait;
    }
    const { projectId } = z.object({ projectId: z.string() }).parse(input);
    return removed || projectId !== (archived ? 'archived' : task.projectId) ? [] : [task];
  }
  if (path === 'periodicTask.delete') {
    removed = true;
    return { success: true };
  }
  if (path === 'periodicTask.listExecutions') {
    return [
      {
        id: 'run',
        periodicTaskId: 'agent',
        workspaceId: 'archived-workspace',
        status: 'FAILED',
        startedAt: new Date(),
        completedAt: new Date(),
        errorMessage: 'Provider failed',
        prUrl: null,
        prNumber: null,
      },
    ];
  }
  if (path === 'periodicTask.create') {
    return { ...task, id: 'created' };
  }
  return task;
}
function render(path = '/agents/agent') {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            requests.push({ path: op.path, input: op.input });
            void executeRequest(op.path, op.type, op.input).then(
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
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route
                path="/agents/:id?"
                element={
                  <>
                    <AgentsPage />
                    <Location />
                  </>
                }
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </trpc.Provider>
    )
  );
}
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === text
  );
  if (!found) {
    throw new Error(`Missing button: ${text}`);
  }
  return found;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  navigation.slug = 'stale';
  failMutation = null;
  failQuery = null;
  missing = false;
  archived = false;
  requests = [];
  mutationWait = undefined;
  removed = false;
  listWait = undefined;
});
afterEach(() => {
  actFlushSync(() => root.unmount());
  queryClient.clear();
  container.remove();
});

describe('AgentsPage coordination', () => {
  it('resolves a deep link independently from stale project selection and links to its owner', async () => {
    render();
    await waitForReact(() =>
      expect(
        container.querySelector('a[href="/projects/owner-slug/workspaces/archived-workspace"]')
      ).not.toBeNull()
    );
    expect(requests).toContainEqual({ path: 'periodicTask.list', input: { projectId: 'owner' } });
    expect(requests).toContainEqual({
      path: 'periodicTask.listExecutions',
      input: { periodicTaskId: 'agent', limit: 50 },
    });
    expect(container.querySelector('output')?.textContent).toBe('/agents/agent');
    await act(async () => navigation.setSlug('stale'));
    await waitForReact(() =>
      expect(
        requests.filter((request) => request.path === 'periodicTask.list').at(-1)?.input
      ).toEqual({ projectId: 'stale' })
    );
    expect(container.querySelector('output')?.textContent).toContain('/agents');
  });
  it('resolves an archived owner through project.getById', async () => {
    archived = true;
    render();
    await waitForReact(() =>
      expect(
        container.querySelector('a[href="/projects/archived-owner/workspaces/archived-workspace"]')
      ).not.toBeNull()
    );
    expect(requests).toContainEqual({ path: 'project.getById', input: { id: 'archived' } });
    expect(container.textContent).toContain('Archived project');
  });
  it('keeps an explicit missing ID and distinguishes not found from request failure', async () => {
    missing = true;
    render('/agents/missing');
    await waitForReact(() => expect(container.textContent).toContain('Agent not found'));
    expect(container.querySelector('output')?.textContent).toBe('/agents/missing');
    expect(container.querySelector('nav[aria-label="Agents"]')).not.toBeNull();
  });
  it('shows task network failure with retry instead of replacing the selection', async () => {
    failQuery = 'periodicTask.get';
    render();
    await waitForReact(() => expect(container.textContent).toContain('Connection unavailable'));
    failQuery = null;
    actFlushSync(() => button('Retry agent').click());
    await waitForReact(() =>
      expect(container.querySelector('h2')?.textContent).toBe('Review changes')
    );
  });
  it('retains edit drafts after failure and polling, then invalidates list and task on success', async () => {
    render();
    await waitForReact(() =>
      expect(container.querySelector('h2')?.textContent).toBe('Review changes')
    );
    actFlushSync(() => button('Edit Agent').click());
    const name = container.querySelector<HTMLInputElement>('input[name="name"]');
    actFlushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(name, 'Changed name');
      name?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    failMutation = 'periodicTask.update';
    await act(async () =>
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    );
    await waitForReact(() => expect(container.textContent).toContain('Server refused the change'));
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(
      'Changed name'
    );
    failQuery = 'periodicTask.get';
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await waitForReact(() => expect(container.textContent).toContain('Connection unavailable'));
    expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(
      'Changed name'
    );
    failQuery = null;
    failMutation = null;
    const before = requests.length;
    await act(async () =>
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    );
    await waitForReact(() => expect(container.querySelector('form')).toBeNull());
    expect(requests.slice(before).some((request) => request.path === 'periodicTask.list')).toBe(
      true
    );
    expect(requests.slice(before).some((request) => request.path === 'periodicTask.get')).toBe(
      true
    );
  });
  it('shows pause and delete failures while preserving the agent and confirmation', async () => {
    render();
    await waitForReact(() =>
      expect(container.querySelector('h2')?.textContent).toBe('Review changes')
    );
    failMutation = 'periodicTask.toggleEnabled';
    actFlushSync(() => button('Pause').click());
    await waitForReact(() => expect(container.textContent).toContain('Server refused the change'));
    failMutation = 'periodicTask.delete';
    actFlushSync(() => button('Delete').click());
    expect(document.body.textContent).toContain('workspaces and conversations are preserved');
    actFlushSync(() => button('Delete Agent').click());
    await waitForReact(() =>
      expect(document.body.textContent).toContain('Server refused the change')
    );
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(container.querySelector('output')?.textContent).toBe('/agents/agent');
  });
  it('preserves an edit draft when the background project request fails', async () => {
    render();
    await waitForReact(() =>
      expect(container.querySelector('h2')?.textContent).toBe('Review changes')
    );
    actFlushSync(() => button('Edit Agent').click());
    actFlushSync(() => navigation.setProjectsError(new Error('Project refresh unavailable')));
    expect(container.querySelector('form')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(
      'Review changes'
    );
    expect(container.textContent).toContain('Project refresh unavailable');
  });
  it('does not override a project switch when a pending creation succeeds', async () => {
    navigation.slug = 'owner-slug';
    render('/agents');
    await waitForReact(() =>
      expect(container.querySelector('h2')?.textContent).toBe('Review changes')
    );
    actFlushSync(() => button('Create Agent').click());
    actFlushSync(() => {
      const name = container.querySelector('input[name="name"]');
      const instructions = container.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        name,
        'New agent'
      );
      name?.dispatchEvent(new Event('input', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        instructions,
        'Find regressions'
      );
      instructions?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    let finishMutation: () => void = vi.fn();
    mutationWait = new Promise<void>((resolve) => {
      finishMutation = resolve;
    });
    actFlushSync(() =>
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    );
    await waitForReact(() =>
      expect(requests.some((request) => request.path === 'periodicTask.create')).toBe(true)
    );
    actFlushSync(() => navigation.setSlug('stale'));
    await waitForReact(() =>
      expect(container.querySelector('output')?.textContent).toBe('/agents')
    );
    await act(async () => {
      finishMutation();
      await Promise.resolve();
    });
    await waitForReact(() =>
      expect(container.querySelector('output')?.textContent).toBe('/agents')
    );
    expect(container.textContent).toContain('Other project');
  });
  it('prevents repeated pause requests while pending and refreshes both task and rail afterward', async () => {
    render();
    await waitForReact(() =>
      expect(container.querySelector('h2')?.textContent).toBe('Review changes')
    );
    let finishMutation: () => void = vi.fn();
    mutationWait = new Promise<void>((resolve) => {
      finishMutation = resolve;
    });
    const before = requests.length;
    actFlushSync(() => {
      button('Pause').click();
      button('Pause').click();
    });
    expect(button('Pause').disabled).toBe(true);
    await waitForReact(() =>
      expect(
        requests.filter((request) => request.path === 'periodicTask.toggleEnabled')
      ).toHaveLength(1)
    );
    await act(async () => {
      finishMutation();
      await Promise.resolve();
    });
    await waitForReact(() => expect(button('Pause').disabled).toBe(false));
    expect(requests.slice(before).some((request) => request.path === 'periodicTask.get')).toBe(
      true
    );
    expect(requests.slice(before).some((request) => request.path === 'periodicTask.list')).toBe(
      true
    );
  });
  it('removes a deleted agent from the cached rail without reopening its stale ID', async () => {
    render();
    await waitForReact(() =>
      expect(container.querySelector('h2')?.textContent).toBe('Review changes')
    );
    let finishList: () => void = vi.fn();
    listWait = new Promise<void>((resolve) => {
      finishList = resolve;
    });
    actFlushSync(() => button('Delete').click());
    actFlushSync(() => button('Delete Agent').click());
    await waitForReact(() =>
      expect(container.querySelector('output')?.textContent).toBe('/agents')
    );
    expect(container.querySelector('a[href="/agents/agent"]')).toBeNull();
    await act(async () => finishList());
  });
  it('creates in the selected project and opens the created agent only after success', async () => {
    navigation.slug = 'owner-slug';
    render('/agents');
    await waitForReact(() =>
      expect(container.querySelector('h2')?.textContent).toBe('Review changes')
    );
    actFlushSync(() => button('Create Agent').click());
    expect(container.textContent).toContain('runs immediately after creation');
    const setters = [
      ['input[name="name"]', 'Daily agent'],
      ['textarea', 'Review code'],
    ] as const;
    actFlushSync(() => {
      for (const [selector, value] of setters) {
        const field = container.querySelector(selector);
        const prototype =
          selector === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
        field?.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    failMutation = 'periodicTask.create';
    await act(async () =>
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    );
    await waitForReact(() => expect(container.textContent).toContain('Server refused the change'));
    expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(
      'Daily agent'
    );
    failMutation = null;
    await act(async () =>
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    );
    await waitForReact(() =>
      expect(container.querySelector('output')?.textContent).toBe('/agents/created')
    );
    expect(requests).toContainEqual({
      path: 'periodicTask.create',
      input: {
        projectId: 'owner',
        name: 'Daily agent',
        prompt: 'Review code',
        cadence: 'DAILY',
        scheduledTime: null,
        timezone: null,
      },
    });
  });
});
