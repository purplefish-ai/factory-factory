// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import { WorkspaceSwitcherDropdown } from './workspace-switcher-dropdown';

const queryState = vi.hoisted(() => ({
  workspaces: [] as {
    id: string;
    name: string;
    createdAt: string;
    kanbanColumn: 'WAITING' | 'WORKING' | 'DONE';
    pendingRequestType: string | null;
  }[],
}));

vi.mock('@phosphor-icons/react/dist/csr/CaretUpDown', () => ({ CaretUpDownIcon: () => null }));

vi.mock('react-router', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('@/client/hooks/use-project-workspace-query', () => {
  return {
    useProjectWorkspaceQuery: (projectId: string | undefined) =>
      trpc.workspace.listForProject.useQuery(
        { projectId: projectId ?? '' },
        { enabled: Boolean(projectId), staleTime: Infinity, refetchOnWindowFocus: false }
      ),
  };
});

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    workspace: {
      listForProject: {
        useQuery: () => ({ data: queryState }),
      },
    },
  },
}));

vi.mock('@/client/components/workspace-item-content', () => ({
  WorkspaceItemContent: ({ workspace }: { workspace: { name: string } }) => (
    <span>{workspace.name}</span>
  ),
}));

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectLabel: ({ children }: { children: ReactNode }) => (
    <div data-testid="group-label">{children}</div>
  ),
  SelectTrigger: ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

let root: Root | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = '';
  queryState.workspaces = [];
});

describe('WorkspaceSwitcherDropdown', () => {
  it('shows board column headers and combines idle and pending Waiting workspaces', () => {
    queryState.workspaces = [
      {
        id: 'idle',
        name: 'Ready for prompt',
        createdAt: '2026-01-01',
        kanbanColumn: 'WAITING',
        pendingRequestType: null,
      },
      {
        id: 'pending',
        name: 'Review requested',
        createdAt: '2026-01-02',
        kanbanColumn: 'WAITING',
        pendingRequestType: 'REVIEW',
      },
      {
        id: 'working',
        name: 'Agent working',
        createdAt: '2026-01-03',
        kanbanColumn: 'WORKING',
        pendingRequestType: null,
      },
      {
        id: 'done',
        name: 'Completed',
        createdAt: '2026-01-04',
        kanbanColumn: 'DONE',
        pendingRequestType: null,
      },
    ];
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        <WorkspaceSwitcherDropdown
          projectSlug="factory-factory"
          projectId="project-1"
          currentWorkspaceId="idle"
          currentWorkspaceLabel="feature/idle"
          currentWorkspaceName="Workspace"
        />
      );
    });
    const labels = Array.from(container.querySelectorAll('[data-testid="group-label"]'));
    expect(labels.map((node) => node.textContent)).toEqual([
      'Working · 1',
      'Waiting · 2',
      'Done · 1',
    ]);
    expect(labels[1]?.parentElement?.textContent).toBe(
      'Waiting · 2Review requestedReady for prompt'
    );
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Open workspace menu (1 working · 2 waiting)'
    );
  });

  it('keeps a long branch label shrinkable and clipped at desktop widths', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        <WorkspaceSwitcherDropdown
          projectSlug="factory-factory"
          projectId="project-1"
          currentWorkspaceId="workspace-1"
          currentWorkspaceLabel="feature/a-very-long-branch-name-that-must-not-overlap-actions"
          currentWorkspaceName="Workspace"
        />
      );
    });

    const trigger = container.querySelector('#workspace-detail-workspace-select');
    const label = container.querySelector('.workspace-switcher-label');

    expect(trigger?.className).toContain('min-w-0');
    expect(label?.className).toContain('truncate');
    expect(label?.className).not.toContain('md:overflow-visible');
    expect(label?.className).not.toContain('md:text-clip');
  });
});
