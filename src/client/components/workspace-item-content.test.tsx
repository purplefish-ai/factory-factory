// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerWorkspace } from '@/client/components/use-workspace-list-state';
import { WorkspaceItemContent } from './workspace-item-content';

vi.mock('@phosphor-icons/react', () => ({
  Clock: () => null,
  DotOutline: () => null,
  GitBranch: () => null,
  GitPullRequest: () => null,
  TreeStructure: () => null,
}));

vi.mock('@/client/components/workspace-status-icon', () => ({
  WorkspaceStatusIcon: () => createElement('span', null),
}));

const baseWorkspace = {
  id: 'ws-1',
  name: 'Workspace',
  branchName: null,
  prUrl: null,
  prNumber: null,
  prState: 'NONE',
  prCiStatus: 'UNKNOWN',
  isWorking: false,
  sessionSummaries: [],
  gitStats: null,
  lastActivityAt: null,
  ratchetEnabled: true,
  ratchetState: 'IDLE',
  sidebarStatus: { activityState: 'IDLE', ciState: 'NONE' },
  ratchetButtonAnimated: false,
  flowPhase: 'NO_PR',
  ciObservation: 'NOT_FETCHED',
  statusReason: null,
  runScriptStatus: 'IDLE',
  pendingRequestType: null,
  cachedKanbanColumn: null,
  stateComputedAt: null,
  snapshotComputedAt: null,
  githubIssueNumber: null,
  githubIssueUrl: null,
  linearIssueId: null,
  linearIssueIdentifier: null,
  linearIssueUrl: null,
} as unknown as ServerWorkspace;

function renderContent(workspace: ServerWorkspace): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  flushSync(() => {
    root.render(createElement(WorkspaceItemContent, { workspace }));
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

    root.unmount();
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

    root.unmount();
    container.remove();
  });
});
