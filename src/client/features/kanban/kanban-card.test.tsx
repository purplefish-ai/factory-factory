// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KanbanCard, type WorkspaceWithKanban } from './kanban-card';

vi.mock('@phosphor-icons/react', () => ({
  ArchiveIcon: () => null,
  ArrowsClockwiseIcon: () => null,
  ChatIcon: () => null,
  DotOutlineIcon: () => null,
  GitBranchIcon: () => null,
  GitPullRequestIcon: () => null,
  PencilIcon: () => null,
  PlayIcon: () => null,
  TreeStructureIcon: () => null,
  WarningIcon: () => null,
}));

vi.mock('react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) =>
    createElement('a', { href: to }, children),
}));

vi.mock('@/client/components/pr-state-badge', () => ({
  PrStateBadge: () => createElement('span', null, 'PR'),
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

vi.mock('@/client/features/workspace', () => ({
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
  statusReason: {
    code: 'READY_FOR_NEXT_PROMPT',
    label: 'Ready for next prompt',
    tone: 'neutral',
    needsUser: true,
  },
} as unknown as WorkspaceWithKanban;

function renderCard(
  workspace: WorkspaceWithKanban,
  onCardClick?: () => void
): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  flushSync(() => {
    root.render(
      createElement(
        'div',
        { onClick: onCardClick },
        createElement(KanbanCard, {
          workspace,
          projectSlug: 'project',
        })
      )
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
  it('renders one canonical status chip for an idle workspace', () => {
    const { container, root } = renderCard(baseWorkspace);
    const chips = container.querySelectorAll('[data-testid="kanban-status-chip"]');

    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toBe('Ready for next prompt');

    root.unmount();
    container.remove();
  });

  it('uses the canonical status chip for setup', () => {
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
    const chips = container.querySelectorAll('[data-testid="kanban-status-chip"]');

    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toBe('Setting up workspace');

    root.unmount();
    container.remove();
  });

  it('renders CI Running once instead of separate status-reason and CI rows', () => {
    const { container, root } = renderCard({
      ...baseWorkspace,
      prUrl: 'https://github.com/example/repo/pull/42',
      prNumber: 42,
      prState: 'OPEN',
      prCiStatus: 'PENDING',
      statusReason: {
        code: 'WAITING_FOR_CI',
        label: 'Waiting for CI',
        tone: 'waiting',
        needsUser: false,
      },
    });
    const chips = container.querySelectorAll('[data-testid="kanban-status-chip"]');

    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toBe('CI Running');
    expect(container.textContent).not.toContain('Waiting for CI');
    expect(container.textContent).not.toMatch(/\bCI\b(?! Running)/);

    root.unmount();
    container.remove();
  });

  it('renders the canonical session-error chip with its detailed message', () => {
    const { container, root } = renderCard({
      ...baseWorkspace,
      statusReason: {
        code: 'SESSION_ERROR',
        label: 'Session error',
        tone: 'danger',
        needsUser: true,
      },
      sessionSummaries: [
        {
          sessionId: 'session-1',
          name: null,
          workflow: null,
          model: null,
          persistedStatus: 'FAILED',
          runtimePhase: 'error',
          processState: 'stopped',
          activity: 'IDLE',
          updatedAt: '2026-05-29T00:00:00.000Z',
          lastExit: null,
          errorMessage: 'Session crashed',
        },
      ],
    });
    const chips = container.querySelectorAll('[data-testid="kanban-status-chip"]');

    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toBe('Session error');
    expect(container.textContent).toContain('Session crashed');

    root.unmount();
    container.remove();
  });

  it('renders an agent-working reason as the canonical chip', () => {
    const { container, root } = renderCard({
      ...baseWorkspace,
      isWorking: true,
      statusReason: {
        code: 'AGENT_WORKING',
        label: 'Agent working',
        tone: 'working',
        needsUser: false,
      },
    });
    const chips = container.querySelectorAll('[data-testid="kanban-status-chip"]');

    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toBe('Agent working');

    root.unmount();
    container.remove();
  });

  it('renders an actionable reason as the canonical chip', () => {
    const { container, root } = renderCard({
      ...baseWorkspace,
      statusReason: {
        code: 'NEEDS_PERMISSION',
        label: 'Needs permission',
        tone: 'attention',
        needsUser: true,
      },
    });
    const chips = container.querySelectorAll('[data-testid="kanban-status-chip"]');

    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toBe('Needs permission');

    root.unmount();
    container.remove();
  });

  it('opens a linked GitHub issue without navigating through the workspace card', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const onCardClick = vi.fn();
    const { container, root } = renderCard(
      {
        ...baseWorkspace,
        githubIssueNumber: 1905,
        githubIssueUrl: 'https://github.com/example/repo/issues/1905',
      },
      onCardClick
    );
    const button = container.querySelector('button');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });

    expect(container.textContent).toContain('#1905');
    expect(container.querySelector('[data-testid="card-content"]')).not.toBeNull();
    expect(button).not.toBeNull();

    button?.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(onCardClick).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith(
      'https://github.com/example/repo/issues/1905',
      '_blank',
      'noopener,noreferrer'
    );

    root.unmount();
    container.remove();
  });

  it('renders linked issue and pull request controls on one metadata row', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const onCardClick = vi.fn();
    const { container, root } = renderCard(
      {
        ...baseWorkspace,
        githubIssueNumber: 1905,
        githubIssueUrl: 'https://github.com/example/repo/issues/1905',
        branchName: 'feature/card-style',
        prUrl: 'https://github.com/example/repo/pull/57',
        prNumber: 57,
        prState: 'DRAFT',
      },
      onCardClick
    );
    const row = container.querySelector('[data-testid="issue-pr-row"]');
    const buttons = row?.querySelectorAll('button');

    expect(row?.textContent).toContain('#1905');
    expect(row?.textContent).toContain('#57');
    expect(row?.textContent).toContain('PR');
    expect(buttons).toHaveLength(2);
    expect(row?.nextElementSibling?.textContent).toContain('feature/card-style');

    buttons?.[0]?.click();
    buttons?.[1]?.click();

    expect(openSpy).toHaveBeenNthCalledWith(
      1,
      'https://github.com/example/repo/issues/1905',
      '_blank',
      'noopener,noreferrer'
    );
    expect(openSpy).toHaveBeenNthCalledWith(
      2,
      'https://github.com/example/repo/pull/57',
      '_blank',
      'noopener,noreferrer'
    );
    expect(onCardClick).not.toHaveBeenCalled();

    root.unmount();
    container.remove();
  });

  it('opens a linked Linear issue from card metadata', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { container, root } = renderCard({
      ...baseWorkspace,
      linearIssueIdentifier: 'ENG-42',
      linearIssueUrl: 'https://linear.app/example/issue/ENG-42',
    });
    const button = container.querySelector('button');

    expect(container.textContent).toContain('ENG-42');
    expect(container.querySelector('[data-testid="card-content"]')).not.toBeNull();
    expect(button).not.toBeNull();

    button?.click();

    expect(openSpy).toHaveBeenCalledWith(
      'https://linear.app/example/issue/ENG-42',
      '_blank',
      'noopener,noreferrer'
    );

    root.unmount();
    container.remove();
  });

  it('prefers a complete Linear link when both issue providers are present', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { container, root } = renderCard({
      ...baseWorkspace,
      githubIssueNumber: 1905,
      githubIssueUrl: 'https://github.com/example/repo/issues/1905',
      linearIssueIdentifier: 'ENG-42',
      linearIssueUrl: 'https://linear.app/example/issue/ENG-42',
    });
    const button = container.querySelector('button');

    expect(container.textContent).toContain('ENG-42');
    expect(container.textContent).not.toContain('#1905');

    button?.click();

    expect(openSpy).toHaveBeenCalledWith(
      'https://linear.app/example/issue/ENG-42',
      '_blank',
      'noopener,noreferrer'
    );

    root.unmount();
    container.remove();
  });

  it('does not render an issue identifier without its URL', () => {
    const { container, root } = renderCard({
      ...baseWorkspace,
      linearIssueIdentifier: 'ENG-42',
      linearIssueUrl: null,
    });

    expect(container.textContent).not.toContain('ENG-42');
    expect(container.querySelector('[data-testid="card-content"]')).not.toBeNull();

    root.unmount();
    container.remove();
  });
});
