import { describe, expect, it } from 'vitest';
import { isArchiveGitIndexLockedError, isWorkspaceDoneOrMerged } from './workspace-archive';

describe('isWorkspaceDoneOrMerged', () => {
  it('returns true when PR state is merged', () => {
    expect(isWorkspaceDoneOrMerged({ prState: 'MERGED' })).toBe(true);
  });

  it('returns true when PR state is closed', () => {
    expect(isWorkspaceDoneOrMerged({ prState: 'CLOSED' })).toBe(true);
  });

  it('returns true when ratchet state is merged', () => {
    expect(isWorkspaceDoneOrMerged({ prState: 'OPEN', ratchetState: 'MERGED' })).toBe(true);
  });

  it('returns true when sidebar CI state is merged', () => {
    expect(
      isWorkspaceDoneOrMerged({
        prState: 'OPEN',
        sidebarStatus: { ciState: 'MERGED' },
      })
    ).toBe(true);
  });

  it('returns true when sidebar CI state is closed', () => {
    expect(
      isWorkspaceDoneOrMerged({
        prState: 'OPEN',
        sidebarStatus: { ciState: 'CLOSED' },
      })
    ).toBe(true);
  });

  it('returns true when live kanban column is done', () => {
    expect(isWorkspaceDoneOrMerged({ kanbanColumn: 'DONE' })).toBe(true);
  });

  it('returns false for non-merged non-done workspaces', () => {
    expect(
      isWorkspaceDoneOrMerged({
        prState: 'OPEN',
        kanbanColumn: 'WAITING',
      })
    ).toBe(false);
  });
});

describe('isArchiveGitIndexLockedError', () => {
  it('recognizes only the machine-readable Git index-lock kind', () => {
    expect(
      isArchiveGitIndexLockedError({
        data: { applicationErrorKind: 'GIT_INDEX_LOCKED' },
      })
    ).toBe(true);
    expect(
      isArchiveGitIndexLockedError({
        data: { code: 'CONFLICT', applicationErrorKind: null },
      })
    ).toBe(false);
    expect(isArchiveGitIndexLockedError(new Error('Git is locked'))).toBe(false);
  });
});
