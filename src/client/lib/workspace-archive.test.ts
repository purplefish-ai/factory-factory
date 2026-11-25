import { describe, expect, it } from 'vitest';
import {
  isArchiveGitIndexLockedError,
  isWorkspaceArchiveIncomplete,
  isWorkspaceDoneOrMerged,
} from './workspace-archive';

describe('isWorkspaceArchiveIncomplete', () => {
  it('reads the server-derived status reason', () => {
    expect(isWorkspaceArchiveIncomplete({ statusReason: { code: 'ARCHIVE_INCOMPLETE' } })).toBe(
      true
    );
    expect(isWorkspaceArchiveIncomplete({ statusReason: { code: 'SETUP_FAILED' } })).toBe(false);
    expect(isWorkspaceArchiveIncomplete({ statusReason: null })).toBe(false);
    expect(isWorkspaceArchiveIncomplete(undefined)).toBe(false);
  });
});

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
