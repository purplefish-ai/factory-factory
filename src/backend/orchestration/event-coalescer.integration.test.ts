import { afterEach, describe, expect, it, vi } from 'vitest';
import { SERVICE_THRESHOLDS } from '@/backend/services/constants';
import { WorkspaceSnapshotStore } from '@/backend/services/workspace';
import { EventCoalescer } from './event-collector.orchestrator';

describe('authoritative Ratchet projection integration', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('moves exhausted failure back to WORKING after direct CI becomes pending', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1000));

    const store = new WorkspaceSnapshotStore();
    store.configure({
      deriveFlowState: () => ({
        phase: 'RATCHET_VERIFY',
        ciObservation: 'CHECKS_FAILED',
        hasActivePr: true,
        isWorking: false,
        shouldAnimateRatchetButton: false,
      }),
      computeKanbanColumn: (input) =>
        input.ratchetDispatchOutcome === 'DIED' &&
        input.ratchetDispatchRetryCount >= SERVICE_THRESHOLDS.ratchetDispatchMaxRetries
          ? 'WAITING'
          : 'WORKING',
      deriveSidebarStatus: () => ({ activityState: 'IDLE', ciState: 'FAILING' }),
    });
    store.upsert(
      'ws-1',
      {
        projectId: 'project-1',
        name: 'Workspace',
        status: 'READY',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      'seed',
      999
    );
    const coalescer = new EventCoalescer(store);

    coalescer.enqueue(
      'ws-1',
      {
        ratchetDispatchOutcome: 'DIED',
        ratchetDispatchRetryCount: SERVICE_THRESHOLDS.ratchetDispatchMaxRetries,
      },
      'projection:ratchet_authoritative',
      { immediate: true }
    );
    expect(store.getByWorkspaceId('ws-1')?.kanbanColumn).toBe('WAITING');

    coalescer.enqueue(
      'ws-1',
      {
        prCiStatus: 'PENDING',
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
      },
      'projection:ratchet_authoritative',
      { immediate: true }
    );

    expect(store.getByWorkspaceId('ws-1')?.kanbanColumn).toBe('WORKING');
  });
});
