import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import {
  createEventCollectorOrchestrator,
  type EventCollectorDependencies,
} from '@/backend/orchestration/event-collector.orchestrator';
import {
  WorkspaceSnapshotStore,
  type workspaceAutoIterationService,
} from '@/backend/services/workspace';
import { deriveWorkspaceSidebarStatus } from '@/shared/core';
import { deriveWorkspaceFlowState } from '@/shared/workspace-flow-state';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

it('keeps same-ms compact updates coherent with lifecycle and stale legacy events', () => {
  vi.useFakeTimers();
  const store = new WorkspaceSnapshotStore();
  store.configure({
    deriveSidebarStatus: deriveWorkspaceSidebarStatus,
    deriveFlowState: (input) => deriveWorkspaceFlowState({ ...input, prUpdatedAt: null }),
  });
  const service = unsafeCoerce<typeof workspaceAutoIterationService>(new EventEmitter());
  const workspaceEvents = new EventEmitter();
  const collector = createEventCollectorOrchestrator(
    unsafeCoerce<EventCollectorDependencies>({
      createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
      prSnapshotService: new EventEmitter(),
      workspaceActivityService: new EventEmitter(),
      workspaceStateMachine: workspaceEvents,
      ratchetService: new EventEmitter(),
      runScriptStateMachine: new EventEmitter(),
      workspaceAutoIterationService: service,
      sessionDomainService: new EventEmitter(),
      workspaceDataService: { subscribeAcceptedBranch: () => vi.fn() },
      workspaceSnapshotStore: store,
    })
  );
  collector.start();
  const readStarted = Date.now();
  store.upsert('ws', { projectId: 'project' }, 'membership seed', readStarted - 1);
  const fields = {
    workspaceId: 'ws',
    mode: 'AUTO_ITERATION',
    autoIterationStatus: 'RUNNING',
    autoIteration: {
      status: 'RUNNING',
      currentIteration: 3,
      maxIterations: 10,
      currentMetricSummary: 'score=1',
    },
  } as const;
  try {
    service.emit('auto_iteration_summary_changed', fields);
    expect(store.getByWorkspaceId('ws')?.autoIteration?.currentMetricSummary).toBe('score=1');
    service.emit('auto_iteration_summary_changed', {
      ...fields,
      autoIteration: { ...fields.autoIteration, currentMetricSummary: 'score=2' },
    });
    workspaceEvents.emit('workspace_state_changed', {
      workspaceId: 'ws',
      fromStatus: 'NEW',
      toStatus: 'READY',
      workspace: {
        projectId: 'project',
        name: 'lifecycle name',
        branchName: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    });
    // Legacy status remains available to other consumers, but cannot regress
    // the compact producer's accepted mode/status/progress as a second owner.
    service.emit('auto_iteration_status_changed', {
      workspaceId: 'ws',
      mode: 'STANDARD',
      status: 'PAUSED',
    });
    vi.advanceTimersByTime(150);
    expect(store.getByWorkspaceId('ws')).toMatchObject({
      mode: 'AUTO_ITERATION',
      autoIterationStatus: 'RUNNING',
      name: 'lifecycle name',
    });
    const version = store.getVersion('ws');
    expect(store.getByWorkspaceId('ws')?.autoIteration?.currentMetricSummary).toBe('score=2');
    store.upsert(
      'ws',
      {
        mode: 'AUTO_ITERATION',
        autoIterationStatus: 'RUNNING',
        autoIteration: fields.autoIteration,
      },
      'old poll',
      readStarted
    );
    expect(store.getByWorkspaceId('ws')?.autoIteration?.currentMetricSummary).toBe('score=2');
    collector.stop();
    service.emit('auto_iteration_summary_changed', { ...fields, autoIteration: null });
    expect(store.getVersion('ws')).toBe(version);
    expect(store.getByWorkspaceId('ws')?.summaryVersion).toBeUndefined();
    collector.start();
    store.remove('ws');
    // The previously accepted atomic row still exists in an event, but it has
    // no membership authority after deletion/removal and cannot resurrect it.
    service.emit('auto_iteration_summary_changed', fields);
    expect(store.getByWorkspaceId('ws')).toBeUndefined();
    expect(
      store.upsert('ws', { projectId: 'project' }, 'pre-removal seed', readStarted).accepted
    ).toBe(false);
    expect(store.getByWorkspaceId('ws')).toBeUndefined();
  } finally {
    collector.stop();
    store.clear();
    vi.useRealTimers();
  }
});
