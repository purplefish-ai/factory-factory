// @vitest-environment jsdom

import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ChildWorkspacesPanel } from './child-workspaces-panel';

const query = vi.hoisted(() => ({
  data: [] as [] | undefined,
  error: null as Error | null,
  isLoading: false,
  isFetching: false,
  refetch: vi.fn(),
}));
const projects = vi.hoisted(() => [
  { id: 'active', name: 'Active project', isArchived: false },
  { id: 'archived', name: 'Archived project', isArchived: true },
]);

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    project: {
      list: {
        useQuery: (filter?: { isArchived?: boolean }) => ({
          data: projects.filter(
            (project) =>
              filter?.isArchived === undefined || project.isArchived === filter.isArchived
          ),
        }),
      },
    },
    workspace: {
      listChildren: { useQuery: () => query },
      createChild: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    useUtils: () => ({ workspace: { listChildren: { invalidate: vi.fn() } } }),
  },
}));

// Keep the project options visible without testing Radix's popover positioning.
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => (
    <div role="option" tabIndex={0}>
      {children}
    </div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
}));

const roots: Root[] = [];

afterEach(() => {
  query.data = [];
  query.error = null;
  query.isFetching = false;
  vi.clearAllMocks();
  for (const root of roots.splice(0)) {
    root.unmount();
  }
  document.body.innerHTML = '';
});

function renderPanel(workspaceId: string) {
  return (
    <TooltipProvider>
      <ChildWorkspacesPanel workspaceId={workspaceId} />
    </TooltipProvider>
  );
}

it('offers active projects and excludes archived child-workspace targets', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  flushSync(() => root.render(renderPanel('parent-1')));
  const createButton = container.querySelector('button[aria-label="New child workspace"]');
  flushSync(() => createButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

  const options = [...document.querySelectorAll('[role="option"]')].map(
    (option) => option.textContent
  );
  expect(options).toContain('Active project');
  expect(options).not.toContain('Archived project');
});

it('shows a failed children query with Retry instead of a blank panel', () => {
  query.data = undefined;
  query.error = new Error('Offline');
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  flushSync(() => root.render(renderPanel('parent')));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Offline');
  const retry = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Retry'
  );
  expect(retry).toBeDefined();
  flushSync(() => retry?.click());
  expect(query.refetch).toHaveBeenCalledOnce();
});
it('keeps loaded children data visible when a background refresh fails', () => {
  query.error = new Error('Offline');
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  flushSync(() => root.render(renderPanel('parent')));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain('No child workspaces yet');
});

it('keeps an unresolved offline child query in Loading instead of a blank panel', () => {
  query.data = undefined;
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  flushSync(() => root.render(renderPanel('parent')));
  expect(container.textContent).toContain('Loading child workspaces…');
  expect(container.textContent).not.toContain('No child workspaces yet');
});
