import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSnapshotStore } from '@/backend/services/workspace';
import { deriveWorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';
import { EventCoalescer } from './event-collector.orchestrator';

describe('authoritative Ratchet projection integration', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a resumed queued PR update waiting until a session starts working', () => {
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
      deriveSidebarStatus: (input) => deriveWorkspaceSidebarStatus(input),
    });
    store.upsert(
      'ws-1',
      {
        projectId: 'project-1',
        name: 'Workspace',
        status: 'READY',
        createdAt: '2026-01-01T00:00:00.000Z',
        ratchetEnabled: true,
      },
      'seed',
      999
    );
    const coalescer = new EventCoalescer(store);

    coalescer.enqueue(
      'ws-1',
      {
        prMonitoring: {
          deliveryMode: 'MAIN',
          enabled: true,
          recipientSessionId: 'main',
          bindingRevision: 1,
          pauseReason: 'DELIVERY_FAILED',
          pendingEventCount: 0,
        },
      },
      'projection:ratchet_authoritative',
      { immediate: true }
    );
    expect(store.getByWorkspaceId('ws-1')?.statusReason.code).toBe('PR_DELIVERY_ERROR');
    expect(store.getByWorkspaceId('ws-1')?.kanbanColumn).toBe('WAITING');

    coalescer.enqueue(
      'ws-1',
      {
        prMonitoring: {
          deliveryMode: 'MAIN',
          enabled: true,
          recipientSessionId: 'main',
          bindingRevision: 1,
          pauseReason: null,
          pendingEventCount: 1,
        },
      },
      'projection:ratchet_authoritative',
      { immediate: true }
    );

    expect(store.getByWorkspaceId('ws-1')?.kanbanColumn).toBe('WAITING');
  });
});
