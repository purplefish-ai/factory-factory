import { describe, expect, it } from 'vitest';
import type { ServerWorkspace } from './use-workspace-list-state';
import { groupWorkspacesForSidebar } from './workspace-sidebar-grouping';

function makeWorkspace(
  overrides: Partial<ServerWorkspace> & { id: string; name: string; createdAt: string }
): ServerWorkspace {
  const { id, name, createdAt, ...rest } = overrides;
  return {
    id,
    name,
    createdAt,
    isWorking: false,
    gitStats: null,
    branchName: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prCiStatus: null,
    kanbanColumn: 'WAITING',
    ...rest,
  };
}

describe('groupWorkspacesForSidebar', () => {
  it('groups strictly by kanbanColumn', () => {
    const workspaces = [
      makeWorkspace({
        id: 'waiting-and-working',
        name: 'Waiting and working',
        createdAt: '2024-02-01T00:00:00Z',
        kanbanColumn: 'WAITING',
        isWorking: true,
      }),
      makeWorkspace({
        id: 'done-and-working',
        name: 'Done and working',
        createdAt: '2024-02-02T00:00:00Z',
        kanbanColumn: 'DONE',
        isWorking: true,
      }),
      makeWorkspace({
        id: 'waiting-only',
        name: 'Waiting only',
        createdAt: '2024-02-03T00:00:00Z',
        kanbanColumn: 'WAITING',
        isWorking: false,
      }),
      makeWorkspace({
        id: 'working-only',
        name: 'Working only',
        createdAt: '2024-02-04T00:00:00Z',
        kanbanColumn: 'WORKING',
        isWorking: false,
      }),
    ];

    const grouped = groupWorkspacesForSidebar(workspaces);

    expect(grouped.waiting.map((workspace) => workspace.id)).toEqual([
      'waiting-only',
      'waiting-and-working',
    ]);
    expect(grouped.working.map((workspace) => workspace.id)).toEqual(['working-only']);
    expect(grouped.done.map((workspace) => workspace.id)).toEqual(['done-and-working']);
  });
});
