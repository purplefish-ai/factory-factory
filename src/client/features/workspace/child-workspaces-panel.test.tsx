// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ChildWorkspacesPanel } from './child-workspaces-panel';

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
      listChildren: { useQuery: () => ({ data: [], isLoading: false }) },
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
  for (const root of roots.splice(0)) {
    root.unmount();
  }
  document.body.innerHTML = '';
});

it('offers active projects and excludes archived child-workspace targets', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  flushSync(() => root.render(createElement(ChildWorkspacesPanel, { workspaceId: 'parent-1' })));
  const createButton = container.querySelector('button[title="New child workspace"]');
  flushSync(() => createButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

  const options = [...document.querySelectorAll('[role="option"]')].map(
    (option) => option.textContent
  );
  expect(options).toContain('Active project');
  expect(options).not.toContain('Archived project');
});
