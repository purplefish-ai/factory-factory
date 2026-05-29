// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KanbanCard, type WorkspaceWithKanban } from './kanban-card';

vi.mock('lucide-react', () => ({
  AlertTriangle: () => null,
  Archive: () => null,
  GitBranch: () => null,
  GitPullRequest: () => null,
  MessageSquare: () => null,
  Pencil: () => null,
  Play: () => null,
  RefreshCw: () => null,
}));

vi.mock('react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) =>
    createElement('a', { href: to }, children),
}));

vi.mock('@/components/shared/ci-status-chip', () => ({
  CiStatusChip: () => createElement('span', null, 'CI'),
}));

vi.mock('@/components/shared/pr-state-badge', () => ({
  PrStateBadge: () => createElement('span', null, 'PR'),
}));

vi.mock('@/components/shared/setup-status-chip', () => ({
  SetupStatusChip: () => createElement('span', null, 'Setup'),
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: import('react').ButtonHTMLAttributes<HTMLButtonElement>) =>
    createElement('button', props, children),
}));

vi.mock('@/components/ui/card', () => ({
  Card: ({ children, ...props }: import('react').HTMLAttributes<HTMLDivElement>) =>
    createElement('div', props, children),
  CardContent: ({ children, ...props }: import('react').HTMLAttributes<HTMLDivElement>) =>
    createElement('div', { ...props, 'data-testid': 'card-content' }, children),
  CardHeader: ({ children, ...props }: import('react').HTMLAttributes<HTMLDivElement>) =>
    createElement('div', props, children),
  CardTitle: ({ children, ...props }: import('react').HTMLAttributes<HTMLDivElement>) =>
    createElement('div', props, children),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  TooltipContent: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  TooltipTrigger: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));

vi.mock('@/components/workspace', () => ({
  ArchiveWorkspaceDialog: () => null,
  RatchetToggleButton: () => null,
  WorkspaceStatusBadge: ({ status }: { status: string }) => createElement('span', null, status),
}));

const baseWorkspace = {
  id: 'ws-1',
  name: 'Workspace',
  branchName: null,
  prUrl: null,
  prNumber: null,
  prState: 'NONE',
  prCiStatus: 'UNKNOWN',
  status: 'READY',
  kanbanColumn: 'WAITING',
  isWorking: false,
  initErrorMessage: null,
  ratchetEnabled: true,
  ratchetState: 'IDLE',
  isArchived: false,
  mode: 'STANDARD',
  sessionSummaries: [],
  pendingRequestType: null,
} as unknown as WorkspaceWithKanban;

function renderCard(workspace: WorkspaceWithKanban): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  flushSync(() => {
    root.render(
      createElement(KanbanCard, {
        workspace,
        projectSlug: 'project',
      })
    );
  });

  return { container, root };
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('KanbanCard', () => {
  it('does not render default idle status reasons as card metadata', () => {
    const { container, root } = renderCard({
      ...baseWorkspace,
      statusReason: {
        code: 'NO_SESSION_STARTED',
        label: 'No session started',
        tone: 'neutral',
        needsUser: true,
      },
    });

    expect(container.textContent).not.toContain('No session started');
    expect(container.querySelector('[data-testid="card-content"]')).toBeNull();

    root.unmount();
    container.remove();
  });

  it('does not duplicate setup status reason with the setup chip', () => {
    const { container, root } = renderCard({
      ...baseWorkspace,
      status: 'PROVISIONING',
      statusReason: {
        code: 'SETTING_UP',
        label: 'Setting up workspace',
        tone: 'working',
        needsUser: false,
      },
    });

    expect(container.textContent).toContain('Setup');
    expect(container.textContent).not.toContain('Setting up workspace');

    root.unmount();
    container.remove();
  });

  it('renders actionable status reasons', () => {
    const { container, root } = renderCard({
      ...baseWorkspace,
      statusReason: {
        code: 'NEEDS_PERMISSION',
        label: 'Needs permission',
        tone: 'attention',
        needsUser: true,
      },
    });

    expect(container.textContent).toContain('Needs permission');
    expect(container.querySelector('[data-testid="card-content"]')).not.toBeNull();

    root.unmount();
    container.remove();
  });
});
