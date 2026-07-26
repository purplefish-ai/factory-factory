import { describe, expect, it } from 'vitest';
import type { WorkspaceSnapshotEntry } from '@/shared/workspace-snapshot';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { makeWorkspaceSnapshotEntry } from '@/test-utils/workspace-snapshot';
import {
  mergeProjectSnapshotIntoWorkspaceDetail,
  type ProjectWorkspace,
  projectSnapshotToWorkspace,
  type WorkspaceDetail,
} from './snapshot-to-workspace';

function makeEntry(overrides: Partial<WorkspaceSnapshotEntry> = {}): WorkspaceSnapshotEntry {
  return makeWorkspaceSnapshotEntry({
    version: 3,
    source: 'event:workspace_state_change',
    name: 'my-workspace',
    branchName: 'feat/snapshot',
    prUrl: 'https://github.com/org/repo/pull/42',
    prNumber: 42,
    prState: 'OPEN',
    prCiStatus: 'SUCCESS',
    prUpdatedAt: '2026-01-14T12:00:00Z',
    ratchetEnabled: true,
    ratchetState: 'IDLE',
    ratchetDispatchOutcome: 'DIED',
    ratchetDispatchRetryCount: 2,
    runScriptStatus: 'IDLE',
    hasHadSessions: true,
    isWorking: true,
    pendingRequestType: 'plan_approval',
    sessionSummaries: [],
    gitStats: { total: 10, additions: 7, deletions: 3, hasUncommitted: false },
    lastActivityAt: '2026-01-15T09:55:00Z',
    sidebarStatus: { activityState: 'WORKING', ciState: 'PASSING' },
    kanbanColumn: 'WORKING',
    flowPhase: 'CI_WAIT',
    ciObservation: 'CHECKS_PASSED',
    statusReason: {
      code: 'NEEDS_PLAN_APPROVAL',
      label: 'Needs plan approval',
      tone: 'attention',
      needsUser: true,
    },
    fieldTimestamps: {
      workspace: 1000,
      pr: 2000,
      session: 3000,
      ratchet: 4000,
      runScript: 5000,
      reconciliation: 6000,
    },
    ...overrides,
  });
}

/**
 * A detail cache entry seeded from a list row, as the app holds after a fetch.
 * `workspace.get` returns the whole database row, so the fields this test does
 * not assert on are irrelevant to the merge under test.
 */
function seedDetail(listed: ProjectWorkspace): WorkspaceDetail {
  return unsafeCoerce<WorkspaceDetail>({ ...listed, hasHadSessions: true, prUpdatedAt: null });
}

describe('workspace snapshot cache projections', () => {
  it('projects the same live fields into the list and detail caches', () => {
    const entry = makeEntry({
      sessionSummaries: [
        {
          sessionId: 'session-1',
          name: 'Implementation',
          workflow: 'implement',
          model: 'gpt-5',
          provider: 'CODEX',
          persistedStatus: 'RUNNING',
          runtimePhase: 'running',
          processState: 'alive',
          activity: 'WORKING',
          updatedAt: '2026-01-15T09:55:00Z',
          lastExit: null,
        },
      ],
    });
    const listed = projectSnapshotToWorkspace(entry);
    const detail = mergeProjectSnapshotIntoWorkspaceDetail(entry, seedDetail(listed));

    for (const projection of [listed, detail]) {
      expect(projection).toMatchObject({
        id: 'ws-1',
        projectId: 'proj-1',
        name: 'my-workspace',
        status: 'READY',
        createdAt: new Date('2026-01-10T08:00:00Z'),
        branchName: 'feat/snapshot',
        prUrl: 'https://github.com/org/repo/pull/42',
        prNumber: 42,
        prState: 'OPEN',
        prCiStatus: 'SUCCESS',
        ratchetEnabled: true,
        ratchetState: 'IDLE',
        runScriptStatus: 'IDLE',
        isWorking: true,
        sessionSummaries: entry.sessionSummaries,
        pendingRequestType: 'plan_approval',
        kanbanColumn: 'WORKING',
        sidebarStatus: entry.sidebarStatus,
        ratchetButtonAnimated: false,
        flowPhase: 'CI_WAIT',
        ciObservation: 'CHECKS_PASSED',
        statusReason: entry.statusReason,
      });
    }
  });

  it('projects git stats and last activity into the list cache', () => {
    const listed = projectSnapshotToWorkspace(makeEntry());

    expect(listed.gitStats).toEqual({
      total: 10,
      additions: 7,
      deletions: 3,
      hasUncommitted: false,
    });
    expect(listed.lastActivityAt).toBe('2026-01-15T09:55:00Z');
  });

  it('applies transported PR update timing and dispatch state to the detail cache', () => {
    const entry = makeEntry({ prUpdatedAt: '2026-02-02T12:00:00Z' });
    const detail = mergeProjectSnapshotIntoWorkspaceDetail(
      entry,
      seedDetail(projectSnapshotToWorkspace(entry))
    );

    expect(detail?.prUpdatedAt).toEqual(new Date('2026-02-02T12:00:00Z'));
    expect(detail?.ratchetDispatchOutcome).toBe('DIED');
    expect(detail?.ratchetDispatchRetryCount).toBe(2);
    expect(detail?.hasHadSessions).toBe(true);
  });

  it('preserves mutation-only issue and creation fields from the existing entry', () => {
    const entry = makeEntry({ name: 'snapshot-name' });
    const existing: ProjectWorkspace = {
      ...projectSnapshotToWorkspace(entry),
      githubIssueNumber: 1959,
      githubIssueUrl: 'https://github.com/purplefish-ai/factory-factory/issues/1959',
      linearIssueId: 'linear-id',
      linearIssueIdentifier: 'ENG-1959',
      linearIssueUrl: 'https://linear.app/issue/ENG-1959',
      creationSource: 'CHILD_WORKSPACE',
      mode: 'AUTO_ITERATION',
      initErrorMessage: 'setup failed once',
    };

    expect(projectSnapshotToWorkspace(entry, existing)).toMatchObject({
      name: 'snapshot-name',
      githubIssueNumber: 1959,
      githubIssueUrl: 'https://github.com/purplefish-ai/factory-factory/issues/1959',
      linearIssueId: 'linear-id',
      linearIssueIdentifier: 'ENG-1959',
      linearIssueUrl: 'https://linear.app/issue/ENG-1959',
      creationSource: 'CHILD_WORKSPACE',
      mode: 'AUTO_ITERATION',
      initErrorMessage: 'setup failed once',
    });
  });

  it('supplies mutation-only defaults for a workspace the snapshot introduces first', () => {
    expect(projectSnapshotToWorkspace(makeEntry())).toMatchObject({
      creationSource: 'MANUAL',
      mode: 'STANDARD',
      initErrorMessage: null,
      githubIssueNumber: null,
      githubIssueUrl: null,
      linearIssueId: null,
      linearIssueIdentifier: null,
      linearIssueUrl: null,
      autoIterationStatus: null,
      autoIterationConfig: null,
      autoIterationProgress: null,
    });
  });

  it('keeps detail cache absent when no detail was fetched', () => {
    expect(mergeProjectSnapshotIntoWorkspaceDetail(makeEntry(), undefined)).toBeUndefined();
  });
});
