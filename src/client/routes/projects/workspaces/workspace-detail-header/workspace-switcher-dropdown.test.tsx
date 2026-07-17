// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSwitcherDropdown } from './workspace-switcher-dropdown';

vi.mock('@phosphor-icons/react', () => ({
  CaretUpDownIcon: () => null,
}));

vi.mock('react-router', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    workspace: {
      getProjectSummaryState: {
        useQuery: () => ({ data: { workspaces: [] } }),
      },
    },
  },
}));

vi.mock('@/client/components/workspace-item-content', () => ({
  WorkspaceItemContent: () => null,
}));

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
});

describe('WorkspaceSwitcherDropdown', () => {
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
