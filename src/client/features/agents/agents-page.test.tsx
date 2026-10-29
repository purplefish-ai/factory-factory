// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ProjectSectionNavigation } from '@/client/components/project-section-header';
import { trpc } from '@/client/lib/trpc';
import { actFlushSync, waitForReact } from '@/test-utils/react-act';
import { AgentsPage } from './agents-page';
import type { Agent } from './types';

const notifications = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('sonner', () => ({ toast: notifications }));
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
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/client/hooks/use-app-navigation-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/client/hooks/use-app-navigation-data')>()),
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
let discoveredAgent: boolean;
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
function OpenCurrentIndex() {
  const navigate = useNavigate();
  const { slug } = useParams();
  return (
    <button
      type="button"
      onClick={() => {
        void navigate(`/projects/${slug}/agents`);
      }}
    >
      Open current index
    </button>
  );
}
function ReturnToOwner() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => {
        void navigate('/projects/owner-slug/agents');
      }}
    >
      Return to owner
    </button>
  );
}
function HeaderProjectSwitch() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => {
        navigation.setSlug('stale');
        void navigate('/projects/stale/agents');
      }}
    >
      Switch header project
    </button>
  );
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
async function listResponse(input: unknown) {
  if (removed) {
    await listWait;
  }
  const { projectId } = z.object({ projectId: z.string() }).parse(input);
  if (discoveredAgent && projectId === 'stale') {
    return [{ ...task, projectId: 'stale' }];
  }
  return removed || projectId !== (archived ? 'archived' : task.projectId) ? [] : [task];
}
async function queryResponse(path: string, input: unknown) {
  if (path === 'periodicTask.get') {
    return taskResponse(input);
  }
  if (path === 'project.getById') {
    return { id: 'archived', slug: 'archived-owner', name: 'Archived project' };
  }
  if (path === 'periodicTask.list') {
    return await listResponse(input);
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
function ScopedPage() {
  const { slug } = useParams();
  const project = projects.find((p) => p.slug === slug) ?? {
    id: 'archived',
    slug: 'archived-owner',
    name: 'Archived project',
  };
  return (
    <>
      <ProjectSectionNavigation project={project} />
      <AgentsPage key={project.id} project={project} />
    </>
  );
}
function render(path = '/projects/owner-slug/agents/agent') {
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
                path="/projects/:slug/agents/:id?"
                element={
                  <>
                    <ScopedPage />
                    <Location />
                    <HeaderProjectSwitch />
                    <ReturnToOwner />
                    <OpenCurrentIndex />
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
  notifications.error.mockClear();
  failMutation = null;
  failQuery = null;
  missing = false;
  archived = false;
  requests = [];
  mutationWait = undefined;
  removed = false;
  listWait = undefined;
  discoveredAgent = false;
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
    expect(container.querySelector('output')?.textContent).toBe(
      '/projects/owner-slug/agents/agent'
    );
    await act(async () => button('Switch header project').click());
    await waitForReact(() =>
      expect(
        requests.filter((request) => request.path === 'periodicTask.list').at(-1)?.input
      ).toEqual({ projectId: 'stale' })
    );
    expect(container.querySelector('output')?.textContent).toContain('/agents');
  });
  it('uses the explicitly resolved archived route project', async () => {
    archived = true;
    render('/projects/archived-owner/agents/agent');
    await waitForReact(() =>
      expect(
        container.querySelector('a[href="/projects/archived-owner/workspaces/archived-workspace"]')
      ).not.toBeNull()
    );
    expect(requests.some((request) => request.path === 'project.getById')).toBe(false);
    expect(container.textContent).toContain('Archived project');
  });
  it('keeps an explicit missing ID and distinguishes not found from request failure', async () => {
    missing = true;
    render('/projects/owner-slug/agents/missing');
    await waitForReact(() => expect(container.textContent).toContain('Agent not found'));
    expect(container.querySelector('output')?.textContent).toBe(
      '/projects/owner-slug/agents/missing'
    );
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
  it('retains cached detail and history after a network poll failure and retries the task', async () => {
    render();
    await waitForReact(() =>
      expect(container.querySelector('h2')?.textContent).toBe('Review changes')
    );
    await waitForReact(() =>
      expect(
        container.querySelector('a[href="/projects/owner-slug/workspaces/archived-workspace"]')
      ).not.toBeNull()
    );
    failQuery = 'periodicTask.get';
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await waitForReact(() => expect(container.textContent).toContain('Connection unavailable'));
    expect(container.querySelector('h2')?.textContent).toBe('Review changes');
    expect(container.querySelector('main')?.textContent).toContain('Find bugs');
    expect(
      container.querySelector('a[href="/projects/owner-slug/workspaces/archived-workspace"]')
    ).not.toBeNull();
    const before = requests.filter((request) => request.path === 'periodicTask.get').length;
    failQuery = null;
    actFlushSync(() => button('Retry agent').click());
    await waitForReact(() => expect(container.textContent).not.toContain('Connection unavailable'));
    expect(
      requests.filter((request) => request.path === 'periodicTask.get').length
    ).toBeGreaterThan(before);
  });
  it('shows NOT_FOUND instead of stale cached detail when the definition no longer exists', async () => {
    render();
    await waitForReact(() =>
      expect(container.querySelector('h2')?.textContent).toBe('Review changes')
    );
    missing = true;
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await waitForReact(() => expect(container.textContent).toContain('Agent not found'));
    expect(container.querySelector('main h2')).toBeNull();
    expect(container.querySelector('main [aria-label="Run history"]')).toBeNull();
  });
  it('preserves exact unsaved instructions through cached NOT_FOUND, retry, and a failed save', async () => {
    render();
    await waitForReact(() =>
      expect(container.querySelector('h2')?.textContent).toBe('Review changes')
    );
    actFlushSync(() => button('Edit Agent').click());
    const form = container.querySelector('form');
    const instructions = container.querySelector<HTMLTextAreaElement>('textarea');
    const draft = 'Unsaved instructions with specific changes.\nKeep this second line too.';
    actFlushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        instructions,
        draft
      );
      instructions?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    missing = true;
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await waitForReact(() =>
      expect(container.textContent).toContain('Agent not found. This agent is no longer available.')
    );
    expect(container.querySelector('form')).toBe(form);
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(draft);
    const before = requests.filter((request) => request.path === 'periodicTask.get').length;
    actFlushSync(() => button('Retry agent').click());
    await waitForReact(() =>
      expect(
        requests.filter((request) => request.path === 'periodicTask.get').length
      ).toBeGreaterThan(before)
    );
    failMutation = 'periodicTask.update';
    actFlushSync(() =>
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    );
    await waitForReact(() => expect(container.textContent).toContain('Server refused the change'));
    expect(container.querySelector('form')).toBe(form);
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(draft);
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
    expect(notifications.error).toHaveBeenCalled();
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(
      'Changed name'
    );
    expect(notifications.error).toHaveBeenCalledWith(
      'Failed to update agent: Server refused the change'
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
    expect(notifications.error).toHaveBeenCalled();
    expect(notifications.error).toHaveBeenCalledWith(
      'Failed to pause agent: Server refused the change'
    );
    failMutation = 'periodicTask.delete';
    actFlushSync(() => button('Delete').click());
    expect(document.querySelector('[role="alertdialog"]')?.textContent).not.toContain(
      'Server refused the change'
    );
    expect(document.body.textContent).toContain('workspaces and conversations are preserved');
    actFlushSync(() => button('Delete Agent').click());
    await waitForReact(() =>
      expect(document.body.textContent).toContain('Server refused the change')
    );
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(notifications.error).toHaveBeenCalledWith(
      'Failed to delete agent: Server refused the change'
    );
    expect(container.querySelector('output')?.textContent).toBe(
      '/projects/owner-slug/agents/agent'
    );
  });
  it('preserves an edit draft when the background project request fails', async () => {
    render();
    await waitForReact(() =>
      expect(container.querySelector('h2')?.textContent).toBe('Review changes')
    );
    actFlushSync(() => button('Edit Agent').click());
    actFlushSync(() => navigation.setProjectsError(new Error('Project refresh unavailable')));
    expect(container.textContent).toContain('Project refresh unavailable');
    expect(button('Retry projects')).toBeDefined();
    expect(container.querySelector('form')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(
      'Review changes'
    );
    expect(container.querySelector('form')).not.toBeNull();
  });
  it('does not override a project switch when a pending creation succeeds', async () => {
    navigation.slug = 'owner-slug';
    render('/projects/owner-slug/agents');
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
    actFlushSync(() => button('Switch header project').click());
    await waitForReact(() =>
      expect(container.querySelector('output')?.textContent).toBe('/projects/stale/agents')
    );
    await act(async () => {
      finishMutation();
      await Promise.resolve();
    });
    await waitForReact(() =>
      expect(container.querySelector('output')?.textContent).toBe('/projects/stale/agents')
    );
    expect(container.querySelector('form')).toBeNull();
    expect(requests).toContainEqual({ path: 'periodicTask.list', input: { projectId: 'stale' } });
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
      expect(container.querySelector('output')?.textContent).toBe('/projects/owner-slug/agents')
    );
    expect(container.querySelector('a[href="/projects/owner-slug/agents/agent"]')).toBeNull();
    await act(async () => finishList());
  });
  it('leaves Create mode when selecting the current agent in the actual rail', async () => {
    render();
    await waitForReact(() =>
      expect(container.querySelector('h2')?.textContent).toBe('Review changes')
    );
    actFlushSync(() => button('Create Agent').click());
    expect(container.querySelector('form')).not.toBeNull();
    const railLink = container.querySelector<HTMLAnchorElement>(
      'nav[aria-label="Agents"] a[href="/projects/owner-slug/agents/agent"]'
    );
    actFlushSync(() => railLink?.click());
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('h2')?.textContent).toBe('Review changes');
    expect(railLink?.getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('output')?.textContent).toBe(
      '/projects/owner-slug/agents/agent'
    );
  });
  it('keeps the explicitly reselected agent after an in-flight creation succeeds', async () => {
    render();
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
        'Review changes'
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
    actFlushSync(() =>
      container
        .querySelector<HTMLAnchorElement>(
          'nav[aria-label="Agents"] a[href="/projects/owner-slug/agents/agent"]'
        )
        ?.click()
    );
    expect(container.querySelector('form')).toBeNull();
    await act(async () => {
      finishMutation();
      await mutationWait;
    });
    await waitForReact(() => expect(button('Create Agent').disabled).toBe(false));
    expect(container.querySelector('output')?.textContent).toBe(
      '/projects/owner-slug/agents/agent'
    );
  });
  it.each([
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ])(
    'preserves Create mode and browser link behavior for modified rail clicks %j',
    async (modifiers) => {
      render();
      await waitForReact(() =>
        expect(container.querySelector('h2')?.textContent).toBe('Review changes')
      );
      actFlushSync(() => button('Create Agent').click());
      const railLink = container.querySelector<HTMLAnchorElement>(
        'nav[aria-label="Agents"] a[href="/projects/owner-slug/agents/agent"]'
      );
      let browserActionPrevented = true;
      const suppressTestNavigation = (event: MouseEvent) => {
        browserActionPrevented = event.defaultPrevented;
        event.preventDefault();
      };
      document.addEventListener('click', suppressTestNavigation, { once: true });
      actFlushSync(() =>
        railLink?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers })
        )
      );
      expect(browserActionPrevented).toBe(false);
      expect(railLink?.getAttribute('href')).toBe('/projects/owner-slug/agents/agent');
      expect(container.querySelector('form')).not.toBeNull();
      expect(container.querySelector('output')?.textContent).toBe(
        '/projects/owner-slug/agents/agent'
      );
    }
  );
  it('creates in the selected project and opens the created agent only after success', async () => {
    navigation.slug = 'owner-slug';
    render('/projects/owner-slug/agents');
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
    expect(notifications.error).toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(
      'Daily agent'
    );
    expect(notifications.error).toHaveBeenCalledWith(
      'Failed to create agent: Server refused the change'
    );
    failMutation = null;
    await act(async () =>
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    );
    await waitForReact(() =>
      expect(container.querySelector('output')?.textContent).toBe(
        '/projects/owner-slug/agents/created'
      )
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
  it('rejects an agent belonging to another canonical project without switching owner', async () => {
    render('/projects/stale/agents/agent');
    await waitForReact(() => expect(container.textContent).toContain('Agent not found'));
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('main h2')).toBeNull();
    expect(container.querySelector('output')?.textContent).toBe('/projects/stale/agents/agent');
    expect(requests).toContainEqual({ path: 'periodicTask.list', input: { projectId: 'stale' } });
  });

  it.each(['create', 'delete'] as const)(
    'keeps the new A lifetime intact after pending %s completes across A → B → A',
    async (kind) => {
      render();
      await waitForReact(() =>
        expect(container.querySelector('h2')?.textContent).toBe('Review changes')
      );
      if (kind === 'create') {
        actFlushSync(() => button('Create Agent').click());
        actFlushSync(() => {
          for (const [selector, value, prototype] of [
            ['input[name="name"]', 'Old lifetime', HTMLInputElement.prototype],
            ['textarea', 'Old instructions', HTMLTextAreaElement.prototype],
          ] as const) {
            const field = container.querySelector(selector);
            Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
            field?.dispatchEvent(new Event('input', { bubbles: true }));
          }
        });
      } else {
        actFlushSync(() => button('Delete').click());
      }
      let finishMutation: () => void = vi.fn();
      mutationWait = new Promise<void>((resolve) => {
        finishMutation = resolve;
      });
      actFlushSync(() => {
        if (kind === 'create') {
          container
            .querySelector('form')
            ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        } else {
          button('Delete Agent').click();
        }
      });
      await waitForReact(() =>
        expect(requests.some((request) => request.path === `periodicTask.${kind}`)).toBe(true)
      );
      actFlushSync(() => button('Switch header project').click());
      await waitForReact(() =>
        expect(container.querySelector('output')?.textContent).toBe('/projects/stale/agents')
      );
      actFlushSync(() => button('Return to owner').click());
      await waitForReact(() =>
        expect(container.querySelector('output')?.textContent).toBe(
          '/projects/owner-slug/agents/agent'
        )
      );
      await waitForReact(() =>
        expect(container.querySelector('h2')?.textContent).toBe('Review changes')
      );
      actFlushSync(() => button('Create Agent').click());
      const form = container.querySelector('form');
      const input = container.querySelector<HTMLInputElement>('input[name="name"]');
      actFlushSync(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          input,
          'New lifetime draft'
        );
        input?.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        finishMutation();
        await mutationWait;
      });
      await waitForReact(() =>
        expect(
          requests.filter((request) => request.path === 'periodicTask.list').length
        ).toBeGreaterThan(2)
      );
      expect(container.querySelector('output')?.textContent).toBe(
        '/projects/owner-slug/agents/agent'
      );
      expect(container.querySelector('form')).toBe(form);
      expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(
        'New lifetime draft'
      );
      if (kind === 'delete') {
        expect(container.querySelector('nav[aria-label="Agents"] a')).toBeNull();
      }
    }
  );
  it('keeps B selected after a pending delete from A completes', async () => {
    render();
    await waitForReact(() =>
      expect(container.querySelector('h2')?.textContent).toBe('Review changes')
    );
    let finishMutation: () => void = vi.fn();
    mutationWait = new Promise<void>((resolve) => {
      finishMutation = resolve;
    });
    actFlushSync(() => button('Delete').click());
    actFlushSync(() => button('Delete Agent').click());
    await waitForReact(() =>
      expect(requests.some((request) => request.path === 'periodicTask.delete')).toBe(true)
    );
    actFlushSync(() => button('Switch header project').click());
    await waitForReact(() =>
      expect(container.querySelector('output')?.textContent).toBe('/projects/stale/agents')
    );
    await act(async () => {
      finishMutation();
      await mutationWait;
    });
    expect(container.querySelector('output')?.textContent).toBe('/projects/stale/agents');
    expect(container.querySelector('form')).toBeNull();
  });

  it('exits Create when explicitly reopening the same idless project index', async () => {
    render('/projects/stale/agents');
    await waitForReact(() => expect(button('Create Agent').disabled).toBe(false));
    actFlushSync(() => button('Create Agent').click());
    expect(container.querySelector('form')).not.toBeNull();
    actFlushSync(() => button('Open current index').click());
    await waitForReact(() => expect(container.querySelector('form')).toBeNull());
    expect(container.querySelector('output')?.textContent).toBe('/projects/stale/agents');
  });
  it('preserves Create and its draft when polling discovers the first agent in an empty project', async () => {
    render('/projects/stale/agents');
    await waitForReact(() => expect(button('Create Agent').disabled).toBe(false));
    actFlushSync(() => button('Create Agent').click());
    const form = container.querySelector('form');
    const input = container.querySelector<HTMLInputElement>('input[name="name"]');
    actFlushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'Draft during polling'
      );
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    discoveredAgent = true;
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await waitForReact(() =>
      expect(container.querySelector('nav[aria-label="Agents"] a')).not.toBeNull()
    );
    expect(container.querySelector('form')).toBe(form);
    expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(
      'Draft during polling'
    );
    expect(container.querySelector('output')?.textContent).toBe('/projects/stale/agents');
  });
});
