import { describe, expect, it } from 'vitest';
import { WorkspaceSnapshotStore } from './workspace-snapshot-store.service';

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
    deriveSidebarStatus: ({ isWorking }) => ({
      activityState: isWorking ? 'WORKING' : 'IDLE',
      ciState: 'NONE',
    }),
  });
  return store;
}

describe('observed waiting interval', () => {
  it('keeps seeded Waiting unknown until an accepted exit and reentry', () => {
    const store = createStore();
    store.upsert(
      'ws',
      { projectId: 'p', status: 'READY', hasHadSessions: true, isWorking: false },
      'seed',
      100
    );
    expect(store.getByWorkspaceId('ws')?.kanbanColumn).toBe('WAITING');
    expect(store.getByWorkspaceId('ws')?.waitingSince ?? null).toBeNull();
    store.upsert('ws', { isWorking: true }, 'runtime', 200);
    expect(store.getByWorkspaceId('ws')?.kanbanColumn).toBe('WORKING');
    store.upsert('ws', { isWorking: false }, 'runtime', 300);
    expect(store.getByWorkspaceId('ws')?.waitingSince).toBe(new Date(300).toISOString());
    store.upsert('ws', { isWorking: false }, 'reconciliation', 400);
    store.upsert('ws', { name: 'Rename' }, 'metadata', 500);
    store.upsert('ws', { isWorking: true }, 'stale', 250);
    expect(store.getByWorkspaceId('ws')?.waitingSince).toBe(new Date(300).toISOString());
    store.upsert('ws', { isWorking: true }, 'runtime', 600);
    expect(store.getByWorkspaceId('ws')?.waitingSince).toBeNull();
    store.upsert('ws', { isWorking: false }, 'runtime', 700);
    expect(store.getByWorkspaceId('ws')?.waitingSince).toBe(new Date(700).toISOString());
    store.clear();
  });
});
