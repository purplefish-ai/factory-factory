import { describe, expect, it } from 'vitest';
import { deriveWorkspaceFlowState } from '@/backend/services/workspace';
import { deriveWorkspaceSidebarStatus } from '@/shared/core';
import {
  type SnapshotUpdateInput,
  WorkspaceSnapshotStore,
} from './workspace-snapshot-store.service';

function makeUpdate(overrides: Partial<SnapshotUpdateInput> = {}): SnapshotUpdateInput {
  return {
    projectId: 'project-1',
    name: 'Test Workspace',
    status: 'READY',
    createdAt: '2026-01-01T00:00:00Z',
    branchName: 'feature/test',
    prUrl: null,
    prNumber: null,
    prState: 'NONE',
    prCiStatus: 'UNKNOWN',
    prUpdatedAt: null,
    hasMergeConflict: false,
    ratchetEnabled: false,
    ratchetState: 'IDLE',
    prMonitoring: {
      enabled: true,
      recipientSessionId: 'main',
      bindingRevision: 1,
      pauseReason: null,
      pendingEventCount: 0,
    },
    runScriptStatus: 'IDLE',
    hasHadSessions: false,
    mode: 'STANDARD',
    autoIterationStatus: null,
    isWorking: false,
    pendingRequestType: null,
    gitStats: null,
    lastActivityAt: null,
    ...overrides,
  };
}

describe('PR monitoring projection', () => {
  const store = new WorkspaceSnapshotStore();
  it('shows failed CI and paused delivery as waiting without reporting live agent work', () => {
    store.configure({
      deriveFlowState: (input) =>
        deriveWorkspaceFlowState({
          ...input,
          prUpdatedAt: input.prUpdatedAt ? new Date(input.prUpdatedAt) : null,
        }),
      deriveSidebarStatus: deriveWorkspaceSidebarStatus,
    });
    store.upsert(
      'ws-1',
      makeUpdate({
        prUrl: 'https://github.com/org/repo/pull/1',
        prState: 'OPEN',
        ratchetEnabled: true,
        isWorking: false,
      }),
      'test',
      100
    );

    const transitions: SnapshotUpdateInput[] = [
      { prCiStatus: 'PENDING', ratchetState: 'CI_RUNNING' },
      { prCiStatus: 'FAILURE', ratchetState: 'CI_RUNNING' },
      {
        ratchetState: 'CI_FAILED',
        prMonitoring: {
          enabled: true,
          recipientSessionId: 'main',
          bindingRevision: 1,
          pauseReason: 'DELIVERY_FAILED',
          pendingEventCount: 0,
        },
      },
    ];
    const columns: Array<string | null> = [];

    for (const [index, update] of transitions.entries()) {
      store.upsert('ws-1', update, 'test', 200 + index);
      const entry = store.getByWorkspaceId('ws-1');
      expect(entry?.isWorking).toBe(false);
      columns.push(entry?.kanbanColumn ?? null);
    }

    expect(columns).toEqual(['WORKING', 'WAITING', 'WAITING']);
  });
});
