import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SNAPSHOT_CHANGED,
  WorkspaceSnapshotStore,
} from '@/backend/services/workspace/service/snapshot/workspace-snapshot-store.service';
import { makeCompleteWorkspaceSnapshotEntry } from '@/test-utils/workspace-snapshot';

const stores: WorkspaceSnapshotStore[] = [];
function fixture() {
  const store = new WorkspaceSnapshotStore();
  stores.push(store);
  store.configure({
    deriveFlowState: () => ({
      phase: 'NO_PR',
      ciObservation: 'NOT_FETCHED',
      hasActivePr: false,
      isWorking: false,
      shouldAnimateRatchetButton: false,
    }),
    deriveSidebarStatus: () => ({ activityState: 'IDLE', ciState: 'NONE' }),
  });
  store.upsert(
    'workspace',
    { projectId: 'project', status: 'READY', branchName: 'Original', branchUpdatedAt: 100 },
    'seed',
    100
  );
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.clear();
  }
});

describe('independent accepted-branch freshness', () => {
  it('checks observation freshness without advancing the fence or mutating snapshot state', () => {
    const store = fixture();
    const before = structuredClone(store.getByWorkspaceId('workspace'));
    expect(store.canAcceptBranchObservation('workspace', 100)).toBe(false);
    expect(store.canAcceptBranchObservation('workspace', 99)).toBe(false);
    expect(store.canAcceptBranchObservation('workspace', Number.NaN)).toBe(false);
    expect(store.canAcceptBranchObservation('workspace', Infinity)).toBe(false);
    expect(store.canAcceptBranchObservation('workspace', 200)).toBe(true);
    expect(store.getByWorkspaceId('workspace')).toEqual(before);
    expect(store.publishAcceptedBranch('workspace', 'Accepted', 150).accepted).toBe(true);
    expect(store.canAcceptBranchObservation('workspace', 150)).toBe(false);
    expect(store.canAcceptBranchObservation('workspace', 151)).toBe(true);
  });

  it('publishes an accepted rename in the same DB millisecond as its initial canonical seed', () => {
    const store = fixture();
    expect(store.publishAcceptedBranch('workspace', 'Accepted tie', 100)).toEqual({
      accepted: true,
      changed: true,
      emitted: true,
    });
    expect(store.getByWorkspaceId('workspace')?.branchName).toBe('Accepted tie');
  });

  it('publishes committed rename after later unrelated workspace observations without changing their fence', () => {
    const store = fixture();
    store.upsert('workspace', { status: 'FAILED' }, 'newer status', 500);
    expect(store.publishAcceptedBranch('workspace', 'Renamed', 200)).toEqual({
      accepted: true,
      changed: true,
      emitted: true,
    });
    expect(store.getByWorkspaceId('workspace')).toMatchObject({
      branchName: 'Renamed',
      status: 'FAILED',
      fieldTimestamps: { workspace: 500 },
    });
    expect(store.upsert('workspace', { status: 'READY' }, 'stale status', 300).accepted).toBe(
      false
    );
  });

  it('rejects older canonical branches even from a later-observed stale whole seed', () => {
    const store = fixture();
    store.publishAcceptedBranch('workspace', 'Renamed', 200);
    store.upsert(
      'workspace',
      { branchName: 'Stale read', branchUpdatedAt: 100, status: 'FAILED' },
      'late seed',
      1000
    );
    expect(store.getByWorkspaceId('workspace')).toMatchObject({
      branchName: 'Renamed',
      status: 'FAILED',
    });
    expect(store.publishAcceptedBranch('workspace', 'Older result', 150).accepted).toBe(false);
  });

  it('observations cannot replace equal-ms accepted writes, while serialized accepted writes may tie', () => {
    const store = fixture();
    store.publishAcceptedBranch('workspace', 'First accepted', 200);
    store.publishAcceptedBranch('workspace', 'Second accepted', 200);
    store.upsert(
      'workspace',
      { branchName: 'First accepted', branchUpdatedAt: 200 },
      'late equal-ms read',
      1000
    );
    expect(store.getByWorkspaceId('workspace')?.branchName).toBe('Second accepted');
  });

  it('canonical branch freshness is independent of stale workspace-group observations in either direction', () => {
    const store = fixture();
    store.upsert('workspace', { status: 'FAILED' }, 'status', 500);
    expect(
      store.upsert(
        'workspace',
        { branchName: 'New canonical', branchUpdatedAt: 300, status: 'READY' },
        'branch read',
        200
      ).accepted
    ).toBe(true);
    expect(store.getByWorkspaceId('workspace')).toMatchObject({
      branchName: 'New canonical',
      status: 'FAILED',
    });
  });

  it('retains observation timestamp compatibility for generic callers without provenance', () => {
    const store = fixture();
    expect(store.upsert('workspace', { branchName: 'Observed' }, 'legacy', 300).accepted).toBe(
      true
    );
    expect(store.upsert('workspace', { branchName: 'Older' }, 'legacy', 250).accepted).toBe(false);
    expect(store.getByWorkspaceId('workspace')?.branchName).toBe('Observed');
  });

  it('advances the accepted-branch fence for an unchanged value without emitting another version', () => {
    const store = fixture();
    const changed = vi.fn();
    store.on(SNAPSHOT_CHANGED, changed);
    const version = store.getVersion('workspace');
    expect(store.publishAcceptedBranch('workspace', 'Original', 200)).toEqual({
      accepted: true,
      changed: false,
      emitted: false,
    });
    expect(
      store.upsert('workspace', { branchName: 'Older', branchUpdatedAt: 150 }, 'late read', 1000)
        .accepted
    ).toBe(false);
    expect(store.getVersion('workspace')).toBe(version);
    expect(changed).not.toHaveBeenCalled();
  });

  it('does not leak input-only provenance into stored entries or changed events', () => {
    const store = fixture();
    const changed = vi.fn();
    store.on(SNAPSHOT_CHANGED, changed);
    store.publishAcceptedBranch('workspace', 'Renamed', 200);
    expect(store.getByWorkspaceId('workspace')).not.toHaveProperty('branchUpdatedAt');
    expect(changed.mock.calls[0]![0].entry).not.toHaveProperty('branchUpdatedAt');
    expect(JSON.stringify(changed.mock.calls[0]![0])).not.toContain('branchUpdatedAt');
  });

  it('clears independent branch fences on removal and store reset, without recreating tombstones', () => {
    const store = fixture();
    store.publishAcceptedBranch('workspace', 'Renamed', 1000);
    store.remove('workspace', 1100);
    expect(store.publishAcceptedBranch('workspace', 'Late', 1200).accepted).toBe(false);
    expect(store.removalTombstoneCount()).toBe(1);
    store.clear();
    store.upsert(
      'workspace',
      { projectId: 'project', branchName: 'Recreated', branchUpdatedAt: 100 },
      'new store',
      100
    );
    expect(store.getByWorkspaceId('workspace')?.branchName).toBe('Recreated');
  });
});

it.each(['ARCHIVING', 'ARCHIVED'] as const)(
  'accepted branch cannot update a %s cache entry or seed a missing entry',
  (status) => {
    const store = fixture();
    store.upsert('workspace', { status }, 'archive', 300);
    expect(store.publishAcceptedBranch('workspace', 'late', 400).accepted).toBe(false);
    expect(store.publishAcceptedBranch('missing', 'late', 400).accepted).toBe(false);
  }
);
it('requires branch hydration independently, including when accepted null equals the default', () => {
  const store = fixture();
  store.clear();
  const { branchName: _omitted, ...seed } = makeCompleteWorkspaceSnapshotEntry({
    workspaceId: 'workspace',
    projectId: 'project',
  });
  store.upsert('workspace', seed, 'all except branch', 100);
  expect(store.getByWorkspaceId('workspace')?.summaryVersion).toBeUndefined();
  expect(
    store.upsert(
      'workspace',
      { branchName: 'invalid', branchUpdatedAt: Number.NaN },
      'rejected',
      200
    ).accepted
  ).toBe(false);
  expect(store.getByWorkspaceId('workspace')?.summaryVersion).toBeUndefined();
  expect(store.publishAcceptedBranch('workspace', null, 200)).toEqual({
    accepted: true,
    changed: true,
    emitted: true,
  });
  expect(store.getByWorkspaceId('workspace')?.summaryVersion).toBe(1);
  store.remove('workspace', 300);
  store.upsert(
    'workspace',
    { projectId: 'project', branchName: 'new', branchUpdatedAt: 1 },
    'recreate',
    301
  );
  expect(store.getByWorkspaceId('workspace')?.branchName).toBe('new');
});

it('accepted publication hydrates only branch while older independent seed fields can complete the summary', () => {
  const store = fixture();
  store.clear();
  store.upsert('workspace', { projectId: 'project' }, 'membership', 50);
  store.publishAcceptedBranch('workspace', 'accepted', 200);
  expect(store.getByWorkspaceId('workspace')?.summaryVersion).toBeUndefined();
  store.upsert(
    'workspace',
    { ...makeCompleteWorkspaceSnapshotEntry({ projectId: 'project' }), branchUpdatedAt: 100 },
    'older canonical row',
    100
  );
  expect(store.getByWorkspaceId('workspace')).toMatchObject({
    branchName: 'accepted',
    summaryVersion: 1,
  });
});
