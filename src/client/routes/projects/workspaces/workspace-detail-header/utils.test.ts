import { describe, expect, it } from 'vitest';
import {
  getWorkspaceHeaderLabel,
  groupWorkspaceSwitcherItems,
  hasVisiblePullRequest,
  isWorkspaceMerged,
} from './utils';

type TestWorkspace = {
  id: string;
  createdAt: string;
  cachedKanbanColumn: 'WAITING' | 'WORKING' | 'DONE';
  pendingRequestType: string | null;
};

describe('groupWorkspaceSwitcherItems', () => {
  it('groups workspaces by kanban state and pending status, newest first', () => {
    const workspaces: TestWorkspace[] = [
      {
        id: 'todo-old',
        createdAt: '2025-01-01T00:00:00.000Z',
        cachedKanbanColumn: 'WAITING',
        pendingRequestType: null,
      },
      {
        id: 'todo-new',
        createdAt: '2025-02-01T00:00:00.000Z',
        cachedKanbanColumn: 'WAITING',
        pendingRequestType: null,
      },
      {
        id: 'waiting',
        createdAt: '2025-03-01T00:00:00.000Z',
        cachedKanbanColumn: 'WAITING',
        pendingRequestType: 'REVIEW',
      },
      {
        id: 'working',
        createdAt: '2025-04-01T00:00:00.000Z',
        cachedKanbanColumn: 'WORKING',
        pendingRequestType: null,
      },
      {
        id: 'done',
        createdAt: '2025-05-01T00:00:00.000Z',
        cachedKanbanColumn: 'DONE',
        pendingRequestType: null,
      },
    ];

    const grouped = groupWorkspaceSwitcherItems(workspaces as never[]);

    expect(grouped.todo.map((workspace) => workspace.id)).toEqual(['todo-new', 'todo-old']);
    expect(grouped.waiting.map((workspace) => workspace.id)).toEqual(['waiting']);
    expect(grouped.working.map((workspace) => workspace.id)).toEqual(['working']);
    expect(grouped.done.map((workspace) => workspace.id)).toEqual(['done']);
  });
});

describe('getWorkspaceHeaderLabel', () => {
  it('uses workspace name when branch is missing', () => {
    expect(getWorkspaceHeaderLabel(null, 'Workspace Name', false)).toBe('Workspace Name');
  });

  it('uses full branch on desktop', () => {
    expect(getWorkspaceHeaderLabel('feature/branch-name', 'Workspace Name', false)).toBe(
      'feature/branch-name'
    );
  });

  it('uses suffix on mobile when branch contains a slash', () => {
    expect(getWorkspaceHeaderLabel('feature/branch-name', 'Workspace Name', true)).toBe(
      'branch-name'
    );
  });

  it('keeps branch on mobile when branch has no slash', () => {
    expect(getWorkspaceHeaderLabel('branch-name', 'Workspace Name', true)).toBe('branch-name');
  });
});

describe('pr helpers', () => {
  it('detects merged state from any merged source', () => {
    expect(
      isWorkspaceMerged({
        prState: 'OPEN',
        ratchetState: 'MERGED',
        sidebarStatus: { activityState: 'IDLE', ciState: 'RUNNING' },
      })
    ).toBe(true);

    expect(
      isWorkspaceMerged({
        prState: 'OPEN',
        ratchetState: 'IDLE',
        sidebarStatus: { activityState: 'IDLE', ciState: 'MERGED' },
      })
    ).toBe(true);

    expect(
      isWorkspaceMerged({
        prState: 'MERGED',
        ratchetState: 'IDLE',
        sidebarStatus: { activityState: 'IDLE', ciState: 'RUNNING' },
      })
    ).toBe(true);
  });

  it('requires url, number, and non-hidden state for visible PR', () => {
    expect(
      hasVisiblePullRequest({ prUrl: 'https://example.com/pr/1', prNumber: 1, prState: 'OPEN' })
    ).toBe(true);
    expect(hasVisiblePullRequest({ prUrl: null, prNumber: 1, prState: 'OPEN' })).toBe(false);
    expect(
      hasVisiblePullRequest({ prUrl: 'https://example.com/pr/1', prNumber: null, prState: 'OPEN' })
    ).toBe(false);
    expect(
      hasVisiblePullRequest({
        prUrl: 'https://example.com/pr/1',
        prNumber: 1,
        prState: 'NONE',
      })
    ).toBe(false);
  });
});
