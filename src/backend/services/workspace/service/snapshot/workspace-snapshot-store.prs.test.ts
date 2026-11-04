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
  it.each([200, 300, 400])(
    'preserves newer monitoring settings while accepting PR revision at clock %s',
    (timestamp) => {
      const store = createStore();
      store.upsert(
        'ws-1',
        {
          projectId: 'project-1',
          prs: [{ ...first, revision: 1 }],
          ratchetEnabled: true,
          ratchetState: 'MERGED',
        },
        'seed',
        100
      );
      const monitoring = {
        enabled: true,
        deliveryMode: 'MAIN' as const,
        recipientSessionId: null,
        bindingRevision: 1,
        pauseReason: null,
        pendingEventCount: 0,
      };
      const currentMonitoring = { ...monitoring, enabled: false, bindingRevision: 2 };
      store.upsert(
        'ws-1',
        { ratchetEnabled: false, prMonitoring: currentMonitoring },
        'user settings',
        300
      );
      store.upsert(
        'ws-1',
        {
          prs: [{ ...first, revision: 2 }],
          ratchetState: 'IDLE',
          ratchetEnabled: true,
          prMonitoring: { ...monitoring, enabled: true, bindingRevision: 1 },
        },
        'older projection',
        timestamp
      );
      expect(store.getByWorkspaceId('ws-1')).toMatchObject({
        prs: [{ revision: 2 }],
        ratchetState: 'IDLE',
        ratchetEnabled: false,
        prMonitoring: currentMonitoring,
        fieldTimestamps: { ratchet: 300 },
      });
      const nextMonitoring = { ...monitoring, enabled: true, bindingRevision: 3 };
      store.upsert(
        'ws-1',
        { ratchetEnabled: true, prMonitoring: nextMonitoring },
        'new settings read',
        350
      );
      expect(store.getByWorkspaceId('ws-1')).toMatchObject({
        ratchetEnabled: true,
        prMonitoring: nextMonitoring,
      });
    }
  );
  it('rejects monitoring configuration carried by a stale full collection projection', () => {
    const store = createStore();
    store.upsert(
      'ws-1',
      {
        projectId: 'project-1',
        prs: [{ ...first, revision: 1 }],
        prCollectionRevision: 2,
        ratchetEnabled: false,
      },
      'current',
      100
    );
    store.upsert(
      'ws-1',
      { prs: [{ ...first, revision: 0 }], prCollectionRevision: 1, ratchetEnabled: true },
      'stale full projection',
      400
    );
    expect(store.getByWorkspaceId('ws-1')?.ratchetEnabled).toBe(false);
  });
  it('fences pre-detach membership and accepts a genuine reattachment', () => {
    const store = createStore();
    store.upsert(
      'ws-1',
      { projectId: 'project-1', prs: [{ ...first, revision: 1 }], prCollectionRevision: 2 },
      'seed',
      100
    );
    store.upsert('ws-1', { prs: [], prCollectionRevision: 3 }, 'detached', 200);
    expect(store.getByWorkspaceId('ws-1')?.prs).toEqual([]);
    for (const prCollectionRevision of [2, undefined]) {
      store.upsert(
        'ws-1',
        { prs: [{ ...first, revision: 1 }], prCollectionRevision },
        'late pre-detach read',
        400
      );
      expect(store.getByWorkspaceId('ws-1')?.prs).toEqual([]);
    }
    store.upsert(
      'ws-1',
      { prs: [{ ...first, revision: 3 }], prCollectionRevision: 4 },
      'reattached',
      200
    );
    expect(store.getByWorkspaceId('ws-1')?.prs).toEqual([{ ...first, revision: 3 }]);
  });

  it('fences pre-attachment collections, including empty reads', () => {
    const store = createStore();
    store.upsert(
      'ws-1',
      { projectId: 'project-1', prs: [], prCollectionRevision: 0 },
      'empty seed',
      100
    );
    store.upsert(
      'ws-1',
      { prs: [{ ...first, revision: 0 }], prCollectionRevision: 1 },
      'attached',
      100
    );
    store.upsert('ws-1', { prs: [], prCollectionRevision: 0 }, 'late empty read', 400);
    expect(store.getByWorkspaceId('ws-1')?.prs).toEqual([{ ...first, revision: 0 }]);
    store.upsert(
      'ws-1',
      {
        prs: [
          { ...first, revision: 0 },
          { ...second, revision: 0 },
        ],
        prCollectionRevision: 2,
      },
      'sibling attached',
      100
    );
    store.upsert(
      'ws-1',
      { prs: [{ ...first, revision: 0 }], prCollectionRevision: 1 },
      'late pre-sibling read',
      400
    );
    expect(store.getByWorkspaceId('ws-1')?.prs).toEqual([
      { ...first, revision: 0 },
      { ...second, revision: 0 },
    ]);
  });

  it('keeps an authoritative empty collection fenced against legacy row facts', () => {
    const store = createStore();
    store.upsert(
      'ws-1',
      { projectId: 'project-1', prs: [], prCollectionRevision: 0 },
      'empty seed',
      100
    );
    store.upsert('ws-1', { prs: [first] }, 'unversioned projection', 400);
    expect(store.getByWorkspaceId('ws-1')?.prs).toEqual([]);
  });
  it('orders persisted PR revisions independently of asynchronous publication clocks', () => {
    const store = createStore();
    const dismissed = {
      ...first,
      state: 'CLOSED' as const,
      completionDismissed: true,
      revision: 2,
    };
    store.upsert(
      'ws-1',
      { projectId: 'project-1', prs: [dismissed], prState: 'NONE', ratchetState: 'IDLE' },
      'follow-up',
      100
    );
    for (const source of ['projection:pr_authoritative', 'reconciliation']) {
      store.upsert(
        'ws-1',
        {
          prs: [{ ...dismissed, completionDismissed: false, revision: 1 }],
          prState: 'CLOSED',
          ratchetState: 'MERGED',
        },
        source,
        200
      );
      expect(store.getByWorkspaceId('ws-1')).toMatchObject({
        prs: [dismissed],
        prState: 'NONE',
        ratchetState: 'IDLE',
      });
    }
    store.upsert('ws-1', { prs: [{ ...first, revision: 3 }], prState: 'OPEN' }, 'reopened', 100);
    expect(store.getByWorkspaceId('ws-1')?.prState).toBe('OPEN');
    store.upsert(
      'ws-1',
      { prs: [{ ...first, state: 'CLOSED', revision: 4 }], prState: 'CLOSED' },
      'closed again',
      100
    );
    expect(store.getByWorkspaceId('ws-1')?.prState).toBe('CLOSED');
    store.upsert(
      'ws-1',
      {
        prs: [
          { ...first, state: 'CLOSED', revision: 4 },
          { ...second, revision: 0 },
        ],
        prState: 'OPEN',
      },
      'new PR',
      100
    );
    expect(store.getByWorkspaceId('ws-1')?.prState).toBe('OPEN');
  });

  it('does not trust scalar PR or ratchet facts without revision provenance after a revisioned collection', () => {
    const store = createStore();
    store.upsert(
      'ws-1',
      {
        projectId: 'project-1',
        prs: [{ ...first, revision: 2 }],
        prState: 'OPEN',
        ratchetState: 'IDLE',
      },
      'seed',
      100
    );
    store.upsert(
      'ws-1',
      { prState: 'CLOSED', ratchetState: 'MERGED', ratchetEnabled: false },
      'legacy event',
      200
    );
    expect(store.getByWorkspaceId('ws-1')).toMatchObject({
      prState: 'OPEN',
      ratchetState: 'IDLE',
      ratchetEnabled: false,
    });
  });
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
