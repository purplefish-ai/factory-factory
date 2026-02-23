import { describe, expect, it } from 'vitest';
import { isWorkspaceDoneOrMerged } from './workspace-archive';

describe('isWorkspaceDoneOrMerged', () => {
  it('returns true when PR state is merged', () => {
    expect(isWorkspaceDoneOrMerged({ prState: 'MERGED' })).toBe(true);
  });

  it('returns true when live kanban column is done', () => {
    expect(isWorkspaceDoneOrMerged({ kanbanColumn: 'DONE' })).toBe(true);
  });

  it('returns true when cached kanban column is done', () => {
    expect(isWorkspaceDoneOrMerged({ cachedKanbanColumn: 'DONE' })).toBe(true);
  });

  it('returns false for non-merged non-done workspaces', () => {
    expect(
      isWorkspaceDoneOrMerged({
        prState: 'OPEN',
        kanbanColumn: 'WAITING',
        cachedKanbanColumn: 'WAITING',
      })
    ).toBe(false);
  });
});
