// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import { getProjectWorkspaceCacheReconciler } from '@/client/lib/workspace-cache-reconciler';
import { waitForReact } from '@/test-utils/react-act';
import { makeWorkspaceSnapshotEntry as entry } from '@/test-utils/workspace-snapshot';
import { WorkspaceFamilyMenu, WorkspaceParentLink } from './workspace-family-navigation';

const parent = {
  id: 'parent',
  name: 'Authentication refactor',
  projectId: 'api',
  projectName: 'API',
  projectSlug: 'api',
};
const child = {
  id: 'child',
  name: 'Token refresh',
  projectId: 'web',
  kanbanColumn: 'WORKING' as const,
  status: 'READY' as const,
  parentWorkspace: parent,
  childWorkspaceCount: 0,
};
const children = [
  { ...child, projectName: 'Web', projectSlug: 'web' },
  {
    ...child,
    id: 'sibling',
    name: 'Auth tests',
    projectId: 'api',
    projectName: 'API',
    projectSlug: 'api',
    kanbanColumn: 'DONE',
  },
];
const roots: ReturnType<typeof createRoot>[] = [];
const clients: QueryClient[] = [];
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(() => root.unmount());
  }
  for (const client of clients.splice(0)) {
    client.clear();
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
function newRoot() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  return { container, root };
}
async function renderMenu(
  resolve: (path: string) => unknown = (path) =>
    path === 'workspace.listChildren'
      ? children
      : { ...parent, kanbanColumn: 'WAITING', status: 'READY' },
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) {
  clients.push(queryClient);
  const requests: string[] = [];
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            requests.push(op.path);
            try {
              observer.next({ result: { data: resolve(op.path) } });
              observer.complete();
            } catch (error) {
              observer.error(
                TRPCClientError.from(error instanceof Error ? error : new Error(String(error)))
              );
            }
          }),
    ],
  });
  const { container, root } = newRoot();
  await act(() =>
    root.render(
      <MemoryRouter>
        <trpc.Provider client={client} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            <WorkspaceFamilyMenu workspace={child} projectSlug="web" />
          </QueryClientProvider>
        </trpc.Provider>
      </MemoryRouter>
    )
  );
  return {
    container,
    requests,
    open: async () => {
      await act(() =>
        container
          .querySelector('button')!
          .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      );
      await waitForReact(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());
    },
  };
}

it('links to the named parent in its own project', async () => {
  const { container, root } = newRoot();
  await act(() =>
    root.render(
      <MemoryRouter>
        <WorkspaceParentLink parent={parent} projectId="web" />
      </MemoryRouter>
    )
  );
  const link = container.querySelector('a')!;
  expect(link.textContent).toContain('Authentication refactor');
  expect(link.textContent).toContain('API');
  expect(link.getAttribute('href')).toBe('/projects/api/workspaces/parent');
});

it('loads members only on open, retains independent statuses and marks the current child', async () => {
  const { requests, open } = await renderMenu();
  expect(requests).toEqual([]);
  await open();
  await waitForReact(() =>
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Done')
  );
  const menu = document.querySelector('[role="menu"]')!;
  expect(menu.textContent).toContain('Waiting');
  expect(menu.textContent).toContain('Working');
  expect(menu.querySelector('[aria-current="page"]')?.textContent).toContain('Token refresh');
  expect(menu.querySelector('a[href="/projects/api/workspaces/sibling"]')).not.toBeNull();
});

it('offers retry after a failed family read instead of claiming there are no children', async () => {
  let unavailable = true;
  const { open } = await renderMenu((path) => {
    if (path === 'workspace.listChildren') {
      if (unavailable) {
        throw new Error('Offline');
      }
      return children;
    }
    return { ...parent, status: 'READY', kanbanColumn: 'WAITING' };
  });
  await open();
  await waitForReact(() =>
    expect(document.querySelector('[role="menu"]')?.textContent).toContain(
      "Couldn't load children. Retry"
    )
  );
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('No active children');
  unavailable = false;
  const retry = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) =>
    node.textContent?.includes('Retry')
  )!;
  await act(() => retry.click());
  await waitForReact(() =>
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Auth tests')
  );
});

it('keeps listed children when a later poll fails', async () => {
  let unavailable = false;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { open } = await renderMenu((path) => {
    if (path === 'workspace.listChildren') {
      if (unavailable) {
        throw new Error('Offline');
      }
      return children;
    }
    return { ...parent, status: 'READY', kanbanColumn: 'WAITING' };
  }, queryClient);
  await open();
  await waitForReact(() =>
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Auth tests')
  );
  unavailable = true;
  await act(() => queryClient.refetchQueries());
  await waitForReact(() =>
    expect(document.querySelector('[role="menu"]')?.textContent).toContain(
      "Couldn't refresh children. Retry"
    )
  );
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('Auth tests');
});

it('keeps the live stream state of a parent over its polled HTTP detail', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const owner = getProjectWorkspaceCacheReconciler(queryClient, 'api');
  owner.apply(owner.beginConnection(), {
    type: 'snapshot_full',
    projectId: 'api',
    entries: [entry({ workspaceId: 'parent', projectId: 'api', name: 'Live parent name' })],
  });
  const { open } = await renderMenu(
    (path) =>
      path === 'workspace.listChildren'
        ? []
        : { ...parent, name: 'Stale HTTP name', status: 'READY', kanbanColumn: 'WAITING' },
    queryClient
  );
  await open();
  await waitForReact(() =>
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Live parent name')
  );
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('Stale HTTP name');
});

it('keeps an archived parent and the current child navigable when live children are empty', async () => {
  const { open } = await renderMenu((path) =>
    path === 'workspace.listChildren' ? [] : { ...parent, status: 'ARCHIVED', kanbanColumn: null }
  );
  await open();
  await waitForReact(() =>
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Archived')
  );
  expect(document.querySelector('a[href="/projects/api/workspaces/parent"]')).not.toBeNull();
  expect(document.querySelector('[aria-current="page"]')?.textContent).toContain('Token refresh');
});
