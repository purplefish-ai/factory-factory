import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SNAPSHOT_CHANGED,
  WorkspaceSnapshotStore,
} from '@/backend/services/workspace/service/snapshot/workspace-snapshot-store.service';

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
    { projectId: 'project', status: 'READY', name: 'Original', nameUpdatedAt: 100 },
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

describe('independent accepted-name freshness', () => {
  it('publishes an accepted rename in the same DB millisecond as its initial canonical seed', () => {
    const store = fixture();
    expect(store.publishAcceptedName('workspace', 'Accepted tie', 100)).toEqual({
      accepted: true,
      changed: true,
      emitted: true,
    });
    expect(store.getByWorkspaceId('workspace')?.name).toBe('Accepted tie');
  });

  it('publishes committed rename after later unrelated workspace observations without changing their fence', () => {
    const store = fixture();
    store.upsert('workspace', { status: 'FAILED' }, 'newer status', 500);
    expect(store.publishAcceptedName('workspace', 'Renamed', 200)).toEqual({
      accepted: true,
      changed: true,
      emitted: true,
    });
    expect(store.getByWorkspaceId('workspace')).toMatchObject({
      name: 'Renamed',
      status: 'FAILED',
      fieldTimestamps: { workspace: 500 },
    });
    expect(store.upsert('workspace', { status: 'READY' }, 'stale status', 300).accepted).toBe(
      false
    );
  });

  it('rejects older canonical names even from a later-observed stale whole seed', () => {
    const store = fixture();
    store.publishAcceptedName('workspace', 'Renamed', 200);
    store.upsert(
      'workspace',
      { name: 'Stale read', nameUpdatedAt: 100, status: 'FAILED' },
      'late seed',
      1000
    );
    expect(store.getByWorkspaceId('workspace')).toMatchObject({
      name: 'Renamed',
      status: 'FAILED',
    });
    expect(store.publishAcceptedName('workspace', 'Older result', 150).accepted).toBe(false);
  });

  it('observations cannot replace equal-ms accepted writes, while serialized accepted writes may tie', () => {
    const store = fixture();
    store.publishAcceptedName('workspace', 'First accepted', 200);
    store.publishAcceptedName('workspace', 'Second accepted', 200);
    store.upsert(
      'workspace',
      { name: 'First accepted', nameUpdatedAt: 200 },
      'late equal-ms read',
      1000
    );
    expect(store.getByWorkspaceId('workspace')?.name).toBe('Second accepted');
  });

  it('canonical name freshness is independent of stale workspace-group observations in either direction', () => {
    const store = fixture();
    store.upsert('workspace', { status: 'FAILED' }, 'status', 500);
    expect(
      store.upsert(
        'workspace',
        { name: 'New canonical', nameUpdatedAt: 300, status: 'READY' },
        'name read',
        200
      ).accepted
    ).toBe(true);
    expect(store.getByWorkspaceId('workspace')).toMatchObject({
      name: 'New canonical',
      status: 'FAILED',
    });
  });

  it('retains observation timestamp compatibility for generic callers without provenance', () => {
    const store = fixture();
    expect(store.upsert('workspace', { name: 'Observed' }, 'legacy', 300).accepted).toBe(true);
    expect(store.upsert('workspace', { name: 'Older' }, 'legacy', 250).accepted).toBe(false);
    expect(store.getByWorkspaceId('workspace')?.name).toBe('Observed');
  });

  it('advances the accepted-name fence for an unchanged value without emitting another version', () => {
    const store = fixture();
    const changed = vi.fn();
    store.on(SNAPSHOT_CHANGED, changed);
    const version = store.getVersion('workspace');
    expect(store.publishAcceptedName('workspace', 'Original', 200)).toEqual({
      accepted: true,
      changed: false,
      emitted: false,
    });
    expect(
      store.upsert('workspace', { name: 'Older', nameUpdatedAt: 150 }, 'late read', 1000).accepted
    ).toBe(false);
    expect(store.getVersion('workspace')).toBe(version);
    expect(changed).not.toHaveBeenCalled();
  });

  it('does not leak input-only provenance into stored entries or changed events', () => {
    const store = fixture();
    const changed = vi.fn();
    store.on(SNAPSHOT_CHANGED, changed);
    store.publishAcceptedName('workspace', 'Renamed', 200);
    expect(store.getByWorkspaceId('workspace')).not.toHaveProperty('nameUpdatedAt');
    expect(changed.mock.calls[0]![0].entry).not.toHaveProperty('nameUpdatedAt');
    expect(JSON.stringify(changed.mock.calls[0]![0])).not.toContain('nameUpdatedAt');
  });

  it('clears independent name fences on removal and store reset, without recreating tombstones', () => {
    const store = fixture();
    store.publishAcceptedName('workspace', 'Renamed', 1000);
    store.remove('workspace', 1100);
    expect(store.publishAcceptedName('workspace', 'Late', 1200).accepted).toBe(false);
    expect(store.removalTombstoneCount()).toBe(1);
    store.clear();
    store.upsert(
      'workspace',
      { projectId: 'project', name: 'Recreated', nameUpdatedAt: 100 },
      'new store',
      100
    );
    expect(store.getByWorkspaceId('workspace')?.name).toBe('Recreated');
  });
});
