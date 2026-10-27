import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceRename,
  type RenamedWorkspace,
} from '@/backend/orchestration/workspace-rename.orchestrator';
import { SNAPSHOT_CHANGED, WorkspaceSnapshotStore } from '@/backend/services/workspace';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

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
    { projectId: 'project', name: 'Before rename', status: 'READY', nameUpdatedAt: 100 },
    'seed',
    100
  );
  const renamed = unsafeCoerce<RenamedWorkspace>({
    id: 'workspace',
    name: 'Canonical persisted name',
    status: 'READY',
    updatedAt: new Date(200),
  });
  const rename = vi.fn(async (_id: string, _name: string) => renamed);
  const changed = vi.fn();
  store.on(SNAPSHOT_CHANGED, changed);
  const useCase = createWorkspaceRename({
    rename,
    publishAcceptedName: (...args) => store.publishAcceptedName(...args),
  });
  return { store, renamed, rename, changed, useCase, renameWorkspace: useCase.rename };
}
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.clear();
  }
});

describe('accepted workspace rename publication', () => {
  it('publishes only the confirmed name after persistence, synchronously before returning the canonical result', async () => {
    const f = fixture();
    let resolve!: (workspace: RenamedWorkspace) => void;
    f.rename.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const result = f.renameWorkspace('workspace', 'Requested name');
    expect(f.changed).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.rename).toHaveBeenCalledTimes(1));
    resolve(f.renamed);
    expect(await result).toEqual(f.renamed);
    expect(f.rename).toHaveBeenCalledExactlyOnceWith('workspace', 'Requested name');
    expect(f.store.getByWorkspaceId('workspace')).toMatchObject({
      name: f.renamed.name,
      status: 'READY',
      fieldTimestamps: { workspace: 100 },
    });
    expect(f.changed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        workspaceId: 'workspace',
        projectId: 'project',
        entry: expect.objectContaining({ name: f.renamed.name }),
      })
    );
  });

  it('propagates the original rejected write without publishing', async () => {
    const f = fixture();
    const error = new Error('Write rejected');
    f.rename.mockRejectedValueOnce(error);
    await expect(f.renameWorkspace('workspace', 'Requested')).rejects.toBe(error);
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.store.getByWorkspaceId('workspace')?.name).toBe('Before rename');
  });

  it.each(['missing', 'removed'] as const)(
    'does not fabricate or resurrect a %s snapshot',
    async (kind) => {
      const f = fixture();
      if (kind === 'missing') {
        f.store.clear();
      } else {
        f.store.remove('workspace', 150);
      }
      const tombstones = f.store.removalTombstoneCount();
      expect(await f.renameWorkspace('workspace', 'Requested')).toBe(f.renamed);
      expect(f.store.getByWorkspaceId('workspace')).toBeUndefined();
      expect(f.store.removalTombstoneCount()).toBe(tombstones);
      expect(f.changed).not.toHaveBeenCalled();
    }
  );

  it.each(['ARCHIVING', 'ARCHIVED'] as const)(
    'does not publish into a snapshot already %s',
    async (status) => {
      const f = fixture();
      f.store.upsert('workspace', { status }, 'lifecycle', 150);
      f.changed.mockClear();
      await f.renameWorkspace('workspace', 'Requested');
      expect(f.store.getByWorkspaceId('workspace')).toMatchObject({
        status,
        name: 'Before rename',
      });
      expect(f.changed).not.toHaveBeenCalled();
    }
  );

  it('skips a canonical archived result even when its cached snapshot is still live', async () => {
    const f = fixture();
    f.renamed.status = 'ARCHIVED';
    await f.renameWorkspace('workspace', 'Requested');
    expect(f.changed).not.toHaveBeenCalled();
  });

  it('preserves a newer canonical name and later lifecycle observation', async () => {
    const timestamp = 250;
    const f = fixture();
    f.rename.mockImplementationOnce(() => {
      f.store.upsert(
        'workspace',
        { name: 'Newer name', nameUpdatedAt: timestamp, status: 'FAILED' },
        'later observation',
        timestamp
      );
      f.changed.mockClear();
      return Promise.resolve(f.renamed);
    });
    await f.renameWorkspace('workspace', 'Requested');
    expect(f.store.getByWorkspaceId('workspace')).toMatchObject({
      name: 'Newer name',
      status: 'FAILED',
      fieldTimestamps: { workspace: timestamp },
    });
    expect(f.changed).not.toHaveBeenCalled();
  });

  it('serializes equal-ms renames and publishes each accepted write before starting the next', async () => {
    const f = fixture();
    let finishFirst!: (workspace: RenamedWorkspace) => void;
    f.rename.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        })
    );
    const first = f.renameWorkspace('workspace', 'First requested');
    const second = f.renameWorkspace('workspace', 'Second requested');
    await vi.waitFor(() => expect(f.rename).toHaveBeenCalledTimes(1));
    expect(f.useCase.pendingWorkspaceCount).toBe(1);
    const newer = { ...f.renamed, name: 'Second canonical', updatedAt: f.renamed.updatedAt };
    f.rename.mockImplementationOnce(() => {
      expect(f.store.getByWorkspaceId('workspace')?.name).toBe(f.renamed.name);
      return Promise.resolve(newer);
    });
    finishFirst(f.renamed);
    await expect(first).resolves.toEqual(f.renamed);
    await expect(second).resolves.toEqual(newer);
    expect(f.store.getByWorkspaceId('workspace')?.name).toBe(newer.name);
    expect(f.changed).toHaveBeenCalledTimes(2);
    expect(f.useCase.pendingWorkspaceCount).toBe(0);
  });

  it('releases a rejected rename so the queued write still publishes and the queue is removed', async () => {
    const f = fixture();
    const failure = new Error('rejected');
    f.rename.mockRejectedValueOnce(failure);
    const first = f.renameWorkspace('workspace', 'First');
    const second = f.renameWorkspace('workspace', 'Second');
    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toEqual(f.renamed);
    expect(f.changed).toHaveBeenCalledTimes(1);
    expect(f.useCase.pendingWorkspaceCount).toBe(0);
  });

  it('returns an out-of-order committed result without overwriting a newer published canonical name', async () => {
    const f = fixture();
    const newer = { ...f.renamed, name: 'Newer canonical', updatedAt: new Date(300) };
    f.rename.mockResolvedValueOnce(newer).mockResolvedValueOnce(f.renamed);
    await expect(f.renameWorkspace('workspace', 'Newer')).resolves.toEqual(newer);
    await expect(f.renameWorkspace('workspace', 'Older')).resolves.toEqual(f.renamed);
    expect(f.store.getByWorkspaceId('workspace')?.name).toBe(newer.name);
    expect(f.changed).toHaveBeenCalledTimes(1);
    expect(f.useCase.pendingWorkspaceCount).toBe(0);
  });

  it('does not serialize independent workspaces behind a slow rename', async () => {
    const f = fixture();
    let finishFirst!: (workspace: RenamedWorkspace) => void;
    f.rename.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        })
    );
    const first = f.renameWorkspace('workspace', 'Slow');
    const other = { ...f.renamed, id: 'other' };
    f.rename.mockResolvedValueOnce(other);
    await expect(f.renameWorkspace('other', 'Fast')).resolves.toEqual(other);
    expect(f.useCase.pendingWorkspaceCount).toBe(1);
    finishFirst(f.renamed);
    await first;
    expect(f.useCase.pendingWorkspaceCount).toBe(0);
  });
});
