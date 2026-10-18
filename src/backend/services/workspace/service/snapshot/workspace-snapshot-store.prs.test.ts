import { describe, expect, it, vi } from 'vitest';
import type { WorkspacePullRequest } from '@/shared/workspace-pr';
import { SNAPSHOT_CHANGED, WorkspaceSnapshotStore } from './workspace-snapshot-store.service';

const first: WorkspacePullRequest = {
  id: 'pr-1',
  url: 'https://github.com/org/repo/pull/1',
  number: 1,
  title: 'First',
  headRefName: null,
  baseRefName: null,
  state: 'OPEN',
  reviewState: null,
  ciStatus: 'SUCCESS',
  hasMergeConflict: false,
  syncedAt: null,
};
const second = { ...first, id: 'pr-2', number: 2 };

function createStore() {
  const store = new WorkspaceSnapshotStore();
  store.configure({
    deriveFlowState: () => ({
      phase: 'NO_PR',
      ciObservation: 'CHECKS_UNKNOWN',
      hasActivePr: false,
      isWorking: false,
      shouldAnimateRatchetButton: false,
    }),
    deriveSidebarStatus: () => ({ activityState: 'IDLE', ciState: 'NONE' }),
  });
  return store;
}

describe('snapshot PR changes', () => {
  it('ignores reordering without changing the stored order or emitting a snapshot', () => {
    const store = createStore();
    const handler = vi.fn();
    store.upsert('ws-1', { projectId: 'project-1', prs: [first, second] }, 'seed', 100);
    store.on(SNAPSHOT_CHANGED, handler);

    const result = store.upsert(
      'ws-1',
      { prs: [{ ...second }, { ...first }] },
      'reconciliation',
      200
    );

    expect(result).toEqual({ accepted: true, changed: false, emitted: false });
    expect(store.getByWorkspaceId('ws-1')).toMatchObject({
      prs: [first, second],
      version: 1,
      fieldTimestamps: { pr: 200 },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    [second, { ...first, title: 'Updated' }],
    [second],
    [second, first, { ...first, id: 'pr-3' }],
  ])('publishes changed PR content or membership: %j', (...prs) => {
    const store = createStore();
    store.upsert('ws-1', { projectId: 'project-1', prs: [first, second] }, 'seed', 100);
    expect(store.upsert('ws-1', { prs }, 'reconciliation', 200)).toEqual({
      accepted: true,
      changed: true,
      emitted: true,
    });
  });
});
