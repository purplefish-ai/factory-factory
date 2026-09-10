import { vi } from 'vitest';
import { SERVICE_THRESHOLDS } from '@/backend/services/constants';
import type { WorkspaceSnapshotEntry } from '@/backend/services/workspace';
import type { SessionRuntimeState } from '@/shared/session-runtime';
import type { ReconciliationBridges } from './snapshot-reconciliation.orchestrator';

export function createMockWorkspace(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'ws-1',
    projectId: 'proj-1',
    name: 'Test Workspace',
    status: 'READY',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    branchName: 'feature/test',
    hasHadSessions: true,
    worktreePath: '/path/to/worktree',
    prUrl: 'https://github.com/org/repo/pull/1',
    prNumber: 1,
    prState: 'OPEN',
    prCiStatus: 'SUCCESS',
    prUpdatedAt: new Date('2026-01-02T00:00:00Z'),
    ratchetEnabled: true,
    ratchetState: 'IDLE',
    ratchetDispatchOutcome: 'DIED',
    ratchetDispatchRetryCount: SERVICE_THRESHOLDS.ratchetDispatchMaxRetries,
    ratchetDispatchStalled: true,
    prHasMergeConflict: false,
    mode: 'STANDARD',
    autoIterationStatus: null,
    runScriptStatus: 'IDLE',
    agentSessions: [
      {
        id: 'cs-1',
        name: 'Chat 1',
        workflow: 'followup',
        model: 'claude-sonnet',
        status: 'IDLE',
        updatedAt: new Date('2026-01-03T10:00:00Z'),
      },
      {
        id: 'cs-2',
        name: 'Chat 2',
        workflow: 'followup',
        model: 'claude-sonnet',
        status: 'IDLE',
        updatedAt: new Date('2026-01-03T12:00:00Z'),
      },
    ],
    terminalSessions: [{ id: 'ts-1', updatedAt: new Date('2026-01-03T11:00:00Z') }],
    project: { defaultBranch: 'main' },
    ...overrides,
  };
}

export function createMockBridges(): ReconciliationBridges {
  const runtime: SessionRuntimeState = {
    phase: 'idle',
    processState: 'alive',
    activity: 'IDLE',
    updatedAt: '2026-01-03T12:00:00.000Z',
  };
  return {
    session: {
      getRuntimeSnapshot: vi.fn().mockReturnValue(runtime),
      getAllPendingRequests: vi.fn().mockReturnValue(new Map()),
    },
  };
}

export function createSnapshotEntry(
  overrides: Partial<WorkspaceSnapshotEntry> = {}
): WorkspaceSnapshotEntry {
  return {
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    version: 1,
    computedAt: '2026-01-01T00:00:00Z',
    source: 'reconciliation',
    name: 'Test Workspace',
    status: 'READY',
    createdAt: '2026-01-01T00:00:00Z',
    branchName: 'feature/test',
    prUrl: 'https://github.com/org/repo/pull/1',
    prNumber: 1,
    prState: 'OPEN',
    prCiStatus: 'SUCCESS',
    prUpdatedAt: '2026-01-02T00:00:00Z',
    ratchetEnabled: true,
    ratchetState: 'IDLE',
    ratchetDispatchOutcome: 'DIED',
    ratchetDispatchRetryCount: SERVICE_THRESHOLDS.ratchetDispatchMaxRetries,
    runScriptStatus: 'IDLE',
    hasHadSessions: true,
    isWorking: false,
    pendingRequestType: null,
    sessionSummaries: [],
    gitStats: null,
    lastActivityAt: null,
    sidebarStatus: { activityState: 'IDLE', ciState: 'NONE' },
    kanbanColumn: 'WAITING',
    flowPhase: 'NO_PR',
    ciObservation: 'NOT_FETCHED',
    ratchetButtonAnimated: false,
    fieldTimestamps: {
      workspace: 0,
      pr: 0,
      session: 0,
      ratchet: 0,
      runScript: 0,
      reconciliation: 0,
    },
    ...overrides,
  } as WorkspaceSnapshotEntry;
}
