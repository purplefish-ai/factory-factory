import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { WorkspaceSnapshotStore } from '@/backend/services/workspace';
import { deriveWorkspaceSidebarStatus } from '@/shared/core';
import { deriveWorkspaceFlowState } from '@/shared/workspace-flow-state';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  createEventCollectorOrchestrator,
  type EventCollectorDependencies,
} from './event-collector.orchestrator';

it('schedules initial metadata once per committed user message and removes its listener on stop', () => {
  const sessionEvents = new EventEmitter();
  const schedule = vi.fn().mockResolvedValue(undefined);
  const dependencies = unsafeCoerce<EventCollectorDependencies>({
    createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    prSnapshotService: new EventEmitter(),
    workspaceActivityService: new EventEmitter(),
    workspaceStateMachine: new EventEmitter(),
    ratchetService: new EventEmitter(),
    runScriptStateMachine: new EventEmitter(),
    sessionDomainService: sessionEvents,
    workspaceDataService: { subscribeAcceptedBranch: () => vi.fn() },
    workspaceSnapshotStore: { getAllWorkspaceIds: () => [] },
    workspaceMetadata: { schedule },
  });
  const collector = createEventCollectorOrchestrator(dependencies);
  try {
    collector.start();
    collector.start();
    sessionEvents.emit('user_message_committed', { sessionId: 'session' });
    expect(schedule).toHaveBeenCalledExactlyOnceWith('session', true);

    collector.stop();
    expect(sessionEvents.listenerCount('user_message_committed')).toBe(0);
    sessionEvents.emit('user_message_committed', { sessionId: 'stopped-session' });
    expect(schedule).toHaveBeenCalledTimes(1);

    collector.start();
    sessionEvents.emit('user_message_committed', { sessionId: 'restarted-session' });
    expect(schedule).toHaveBeenCalledTimes(2);
    expect(schedule).toHaveBeenLastCalledWith('restarted-session', true);
  } finally {
    collector.stop();
  }
});

it.each(['PROVISIONING', 'READY', 'FAILED'] as const)(
  'publishes committed metadata on %s without extra I/O',
  (status) => {
    const workspaceEvents = new EventEmitter();
    const findById = vi.fn(() => {
      throw new Error('metadata must use the committed row');
    });
    const store = new WorkspaceSnapshotStore();
    store.configure({
      deriveFlowState: (input) =>
        deriveWorkspaceFlowState({
          ...input,
          prUpdatedAt: input.prUpdatedAt ? new Date(input.prUpdatedAt) : null,
        }),
      deriveSidebarStatus: deriveWorkspaceSidebarStatus,
    });
    const dependencies = unsafeCoerce<EventCollectorDependencies>({
      createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
      prSnapshotService: new EventEmitter(),
      workspaceActivityService: new EventEmitter(),
      workspaceStateMachine: workspaceEvents,
      ratchetService: new EventEmitter(),
      runScriptStateMachine: new EventEmitter(),
      sessionDomainService: new EventEmitter(),
      workspaceDataService: { subscribeAcceptedBranch: () => vi.fn(), findById },
      workspaceSnapshotStore: store,
    });
    const collector = createEventCollectorOrchestrator(dependencies);
    collector.start();
    try {
      workspaceEvents.emit('workspace_state_changed', {
        workspaceId: 'ws',
        fromStatus: 'NEW',
        toStatus: status,
        workspace: {
          projectId: 'project',
          name: 'issue',
          branchName: 'branch',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-02T00:00:00.000Z'),
          worktreePath: status === 'PROVISIONING' ? null : '/work',
          initErrorMessage: status === 'FAILED' ? 'setup failed' : null,
          githubIssueNumber: 42,
          githubIssueUrl: 'https://github.com/org/repo/issues/42',
          linearIssueId: null,
          linearIssueIdentifier: null,
          linearIssueUrl: null,
          creationSource: 'GITHUB_ISSUE',
        },
      });
      expect(store.getByWorkspaceId('ws')).toMatchObject({
        status,
        worktreePath: status === 'PROVISIONING' ? null : '/work',
        initErrorMessage: status === 'FAILED' ? 'setup failed' : null,
        githubIssueNumber: 42,
        githubIssueUrl: 'https://github.com/org/repo/issues/42',
        linearIssueId: null,
        linearIssueIdentifier: null,
        linearIssueUrl: null,
        creationSource: 'GITHUB_ISSUE',
      });
      expect(store.getByWorkspaceId('ws')?.summaryVersion).toBeUndefined();
      expect(findById).not.toHaveBeenCalled();
    } finally {
      collector.stop();
      store.clear();
    }
  }
);
