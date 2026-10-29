// @vitest-environment jsdom

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerWorkspace } from '@/client/components/use-workspace-list-state';
import { createOptimisticWorkspaceSummary } from '@/client/lib/workspace-summary';
import { actFlushSync } from '@/test-utils/react-act';
import { WorkspaceItemContent } from './workspace-item-content';

vi.mock('@/client/features/workspace', () => ({ WorkspacePrMenu: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/Clock', () => ({ ClockIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/DotOutline', () => ({ DotOutlineIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/GitBranch', () => ({ GitBranchIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/GitPullRequest', () => ({
  GitPullRequestIcon: () => null,
}));
vi.mock('@phosphor-icons/react/dist/csr/TreeStructure', () => ({ TreeStructureIcon: () => null }));

vi.mock('@/client/components/workspace-status-icon', () => ({
  WorkspaceStatusIcon: () => createElement('span', null),
}));

const baseWorkspace: ServerWorkspace = {
  ...createOptimisticWorkspaceSummary({
    id: 'ws-1',
    projectId: 'project',
    name: 'Workspace',
    ratchetEnabled: true,
  }),
  isWorking: false,
  kanbanColumn: null,
};

function renderContent(
  workspace: ServerWorkspace,
  {
    onOpenPr,
    onOpenIssue,
    onParentPointerUp,
  }: {
    onOpenPr?: () => void;
    onOpenIssue?: () => void;
    onParentPointerUp?: () => void;
  } = {}
): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  actFlushSync(() => {
    root.render(
      createElement(
        'div',
        { onPointerUp: onParentPointerUp },
        createElement(WorkspaceItemContent, { workspace, onOpenPr, onOpenIssue })
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

describe('WorkspaceItemContent', () => {
  it('opens a pull request without propagating pointerup to its parent', () => {
    const onOpenPr = vi.fn();
    const onParentPointerUp = vi.fn();
    const { container, root } = renderContent(
      {
        ...baseWorkspace,
        prUrl: 'https://github.com/example/repo/pull/42',
        prNumber: 42,
        prState: 'OPEN',
      },
      { onOpenPr, onParentPointerUp }
    );
    const button = container.querySelector('button');

    expect(button).not.toBeNull();
    button?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    button?.click();

    expect(onParentPointerUp).not.toHaveBeenCalled();
    expect(onOpenPr).toHaveBeenCalledOnce();

    actFlushSync(() => root.unmount());
    container.remove();
  });

  it('opens an issue without propagating pointerup to its parent', () => {
    const onOpenIssue = vi.fn();
    const onParentPointerUp = vi.fn();
    const { container, root } = renderContent(
      {
        ...baseWorkspace,
        githubIssueNumber: 1905,
        githubIssueUrl: 'https://github.com/example/repo/issues/1905',
      },
      { onOpenIssue, onParentPointerUp }
    );
    const button = container.querySelector('button');

    expect(button).not.toBeNull();
    button?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    button?.click();

    expect(onParentPointerUp).not.toHaveBeenCalled();
    expect(onOpenIssue).toHaveBeenCalledOnce();

    actFlushSync(() => root.unmount());
    container.remove();
  });

  it('hides default idle status reasons', () => {
    const { container, root } = renderContent({
      ...baseWorkspace,
      statusReason: {
        code: 'READY_FOR_NEXT_PROMPT',
        label: 'Ready for next prompt',
        tone: 'neutral',
        needsUser: true,
      },
    });

    expect(container.textContent).toContain('Workspace');
    expect(container.textContent).not.toContain('Ready for next prompt');

    actFlushSync(() => root.unmount());
    container.remove();
  });

  it('renders actionable status reasons', () => {
    const { container, root } = renderContent({
      ...baseWorkspace,
      statusReason: {
        code: 'NEEDS_ANSWER',
        label: 'Needs your answer',
        tone: 'attention',
        needsUser: true,
      },
    });

    expect(container.textContent).toContain('Needs your answer');

    actFlushSync(() => root.unmount());
    container.remove();
  });
});

it.each(['PERIODIC_TASK', 'MANUAL'] as const)(
  'identifies only agent workspace origins with a robot: %s',
  (creationSource) => {
    const { container, root } = renderContent({ ...baseWorkspace, creationSource });
    expect(container.querySelector('svg[aria-label="Agent workspace"]') !== null).toBe(
      creationSource === 'PERIODIC_TASK'
    );
    actFlushSync(() => root.unmount());
    container.remove();
  }
);
