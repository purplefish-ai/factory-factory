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
        ratchetState: 'READY',
        runScriptStatus: 'IDLE',
        isWorking: true,
        sessionSummaries: entry.sessionSummaries,
        pendingRequestType: 'plan_approval',
        kanbanColumn: 'WAITING',
        sidebarStatus: entry.sidebarStatus,
        ratchetButtonAnimated: false,
        flowPhase: 'READY',
        ciObservation: 'CHECKS_PASSED',
        statusReason: entry.statusReason,
      });
    }
  });

  it('synthesizes a legacy PR association for both cache projections', () => {
    const entry = makeEntry({
      prs: [],
      prSummary: {
        totalCount: 0,
        openCount: 0,
        hasNonterminal: false,
        state: 'NONE',
        ciStatus: 'UNKNOWN',
        hasMergeConflict: false,
        ratchetState: 'IDLE',
      },
      hasMergeConflict: true,
    });
    const listed = projectSnapshotToWorkspace(entry);
    const detail = mergeProjectSnapshotIntoWorkspaceDetail(entry, seedDetail(listed));
    for (const projection of [listed, detail]) {
      expect(projection?.prs).toEqual([
        expect.objectContaining({
          id: 'legacy-pr-ws-1',
          url: 'https://github.com/org/repo/pull/42',
          number: 42,
          state: 'OPEN',
          ciStatus: 'SUCCESS',
          hasMergeConflict: true,
        }),
      ]);
      expect(projection?.prSummary).toMatchObject({ totalCount: 1, openCount: 1 });
    }
  });

  it.each([undefined, []])(
    'preserves cached PR identity and metadata with legacy collection %j',
    (prs) => {
      const original = projectSnapshotToWorkspace(makeEntry());
      const existing = {
        ...original,
        prs: [
          { ...original.prs[0]!, id: 'attached-pr', title: 'Cached title', headRefName: 'feat/pr' },
        ],
      };
      const entry = makeEntry({ prs, prCiStatus: 'FAILURE', prState: 'CHANGES_REQUESTED' });
      const listed = projectSnapshotToWorkspace(entry, existing);
      const detail = mergeProjectSnapshotIntoWorkspaceDetail(entry, seedDetail(existing));
      for (const projection of [listed, detail]) {
        expect(projection?.prs[0]).toMatchObject({
          id: 'attached-pr',
          title: 'Cached title',
          headRefName: 'feat/pr',
          state: 'CHANGES_REQUESTED',
          ciStatus: 'FAILURE',
          reviewState: 'CHANGES_REQUESTED',
        });
        expect(projection?.prSummary).toMatchObject({ totalCount: 1, ciStatus: 'FAILURE' });
      }
    }
  );

  it.each([
    ['CHANGES_REQUESTED', 'REVIEW_PENDING'],
    ['APPROVED', 'READY'],
  ] as const)(
    'preserves the cached %s review decision for a legacy DRAFT observation',
    (reviewState, ratchetState) => {
      const original = projectSnapshotToWorkspace(makeEntry());
      const existing: ProjectWorkspace = {
        ...original,
        prs: [{ ...original.prs[0]!, state: 'DRAFT', reviewState }],
      };
      const entry = makeEntry({ prs: undefined, prState: 'DRAFT', prCiStatus: 'SUCCESS' });
      const listed = projectSnapshotToWorkspace(entry, existing);
      const detail = mergeProjectSnapshotIntoWorkspaceDetail(entry, seedDetail(existing));
      for (const projection of [listed, detail]) {
        expect(projection?.prs[0]).toMatchObject({ state: 'DRAFT', reviewState });
        expect(projection?.prSummary.ratchetState).toBe(ratchetState);
      }
    }
  );

  it.each([
    ['cached-empty', 'https://github.com/org/repo/pull/42', 42, ['attached-a', 'attached-b']],
    ['cached-absent', 'https://github.com/org/repo/pull/42', 42, ['attached-a', 'attached-b']],
    [
      'new-absent',
      'https://github.com/org/repo/pull/44',
      44,
      ['attached-a', 'attached-b', 'legacy-pr-ws-1'],
    ],
    [
      'new-empty',
      'https://github.com/org/repo/pull/44',
      44,
      ['attached-a', 'attached-b', 'legacy-pr-ws-1'],
    ],
  ] as const)(
    'retains sibling PRs for a legacy observation of a %s PR',
    (kind, url, number, ids) => {
      const original = projectSnapshotToWorkspace(makeEntry());
      const cached = original.prs[0]!;
      const existing: ProjectWorkspace = {
        ...original,
        prs: [
          { ...cached, id: 'attached-a', title: 'First PR' },
          {
            ...cached,
            id: 'attached-b',
            url: 'https://github.com/org/repo/pull/43',
            number: 43,
            title: 'Sibling PR',
          },
        ],
        prUrl: null,
        prNumber: null,
      };
      const entry = makeEntry({
        prs: kind.endsWith('absent') ? undefined : [],
        prUrl: url,
        prNumber: number,
        prCiStatus: 'FAILURE',
      });
      const listed = projectSnapshotToWorkspace(entry, existing);
      const detail = mergeProjectSnapshotIntoWorkspaceDetail(entry, seedDetail(existing));
      for (const projection of [listed, detail]) {
        expect(projection?.prs.map((pr) => pr.id)).toEqual(ids);
        expect(projection?.prs.find((pr) => pr.id === 'attached-b')).toMatchObject({
          title: 'Sibling PR',
          ciStatus: 'SUCCESS',
        });
        expect(projection?.prs.find((pr) => pr.url === url)).toMatchObject({ ciStatus: 'FAILURE' });
        expect(projection?.prSummary).toMatchObject({
          totalCount: ids.length,
          ciStatus: 'FAILURE',
        });
        expect(projection?.prUrl).toBeNull();
        expect(projection?.prNumber).toBeNull();
      }
    }
  );

  function legacyMergeWithSibling(overrides: Partial<WorkspaceSnapshotEntry> = {}) {
    const original = projectSnapshotToWorkspace(makeEntry());
    const existing: ProjectWorkspace = {
      ...original,
      prs: [
        { ...original.prs[0]!, id: 'merged-pr' },
        {
          ...original.prs[0]!,
          id: 'open-pr',
          url: 'https://github.com/org/repo/pull/43',
          number: 43,
          ciStatus: 'PENDING',
        },
      ],
    };
    const entry = makeEntry({
      prs: undefined,
      prState: 'MERGED',
      prCiStatus: 'SUCCESS',
      ratchetState: 'MERGED',
      flowPhase: 'MERGED',
      ciObservation: 'CHECKS_PASSED',
      isWorking: false,
      pendingRequestType: null,
      kanbanColumn: 'DONE',
      sidebarStatus: { activityState: 'IDLE', ciState: 'MERGED' },
      statusReason: { code: 'MERGED', label: 'Merged', tone: 'success', needsUser: false },
      ...overrides,
    });
    return { existing, entry };
  }

  it.each([
    ['PENDING', 'CI_RUNNING', 'CI_WAIT', 'CHECKS_PENDING', 'WAITING_FOR_CI', 'RUNNING', true],
    [
      'FAILURE',
      'CI_FAILED',
      'RATCHET_FIXING',
      'CHECKS_FAILED',
      'PR_NEEDS_ATTENTION',
      'FAILING',
      false,
    ],
  ] as const)(
    'keeps aggregate UI nonterminal when a legacy merge leaves a %s sibling',
    (ciStatus, ratchetState, flowPhase, ciObservation, reasonCode, sidebarCi, animated) => {
      const { existing, entry } = legacyMergeWithSibling();
      existing.prs[1]!.ciStatus = ciStatus;
      const listed = projectSnapshotToWorkspace(entry, existing);
      const detail = mergeProjectSnapshotIntoWorkspaceDetail(entry, seedDetail(existing));
      for (const projection of [listed, detail]) {
        expect(projection).toMatchObject({
          prUrl: null,
          prNumber: null,
          prState: 'OPEN',
          prCiStatus: ciStatus,
          ratchetState,
          isWorking: false,
          flowPhase,
          ciObservation,
          ratchetButtonAnimated: animated,
          statusReason: { code: reasonCode },
          kanbanColumn: ciStatus === 'PENDING' ? 'WORKING' : 'WAITING',
          sidebarStatus: { activityState: 'IDLE', ciState: sidebarCi },
          prSummary: { totalCount: 2, hasNonterminal: true },
        });
        expect(projection?.prs.map((pr) => pr.state)).toEqual(['MERGED', 'OPEN']);
      }
    }
  );

  it.each([
    [{ status: 'FAILED' }, 'SETUP_FAILED', 'WAITING'],
    [{ status: 'ARCHIVING' }, 'ARCHIVING', null],
    [{ status: 'NEW' }, 'SETTING_UP', 'WORKING'],
    [{ pendingRequestType: 'permission_request' }, 'NEEDS_PERMISSION', 'WAITING'],
    [{ isWorking: true }, 'AGENT_WORKING', 'WORKING'],
    [
      {
        statusReason: {
          code: 'SESSION_ERROR',
          label: 'Session error',
          tone: 'danger',
          needsUser: true,
        },
      },
      'SESSION_ERROR',
      'WAITING',
    ],
    [
      {
        statusReason: {
          code: 'STARTING_SESSION',
          label: 'Starting session',
          tone: 'working',
          needsUser: false,
        },
      },
      'STARTING_SESSION',
      'WORKING',
    ],
    [{ mode: 'AUTO_ITERATION', autoIterationStatus: 'RUNNING' }, 'AUTO_ITERATING', 'WORKING'],
  ] as const)(
    'preserves non-PR signals %j while correcting legacy aggregate status',
    (overrides, reasonCode, column) => {
      const { existing, entry } = legacyMergeWithSibling(overrides);
      const listed = projectSnapshotToWorkspace(entry, existing);
      const detail = mergeProjectSnapshotIntoWorkspaceDetail(entry, seedDetail(existing));
      for (const projection of [listed, detail]) {
        expect(projection).toMatchObject({
          prState: 'OPEN',
          flowPhase: 'CI_WAIT',
          statusReason: { code: reasonCode },
          kanbanColumn: column,
          isWorking: 'isWorking' in overrides ? overrides.isWorking : false,
        });
      }
    }
  );

  it.each([
    ['error', 'SESSION_ERROR', 'WAITING'],
    ['starting', 'STARTING_SESSION', 'WORKING'],
  ] as const)(
    'retains a %s session signal hidden by the stale merged status',
    (phase, reasonCode, column) => {
      const { existing, entry } = legacyMergeWithSibling({
        sessionSummaries: [
          {
            sessionId: 'session-1',
            name: null,
            workflow: null,
            model: null,
            provider: 'CODEX',
            persistedStatus: phase === 'error' ? 'FAILED' : 'IDLE',
            runtimePhase: phase,
            processState: phase === 'error' ? 'stopped' : 'alive',
            activity: 'IDLE',
            updatedAt: '2026-01-15T09:55:00Z',
            lastExit: null,
            errorMessage: phase === 'error' ? 'Session crashed' : undefined,
          },
        ],
      });
      for (const projection of [
        projectSnapshotToWorkspace(entry, existing),
        mergeProjectSnapshotIntoWorkspaceDetail(entry, seedDetail(existing)),
      ]) {
        expect(projection).toMatchObject({
          statusReason: { code: reasonCode },
          kanbanColumn: column,
        });
      }
    }
  );

  it('projects aggregate conflict and queued PR updates into the detail cache', () => {
    const { existing, entry } = legacyMergeWithSibling({
      prMonitoring: {
        deliveryMode: 'MAIN',
        enabled: true,
        recipientSessionId: 'main-session',
        bindingRevision: 1,
        pauseReason: null,
        pendingEventCount: 1,
      },
    });
    existing.prs[1]!.ciStatus = 'FAILURE';
    existing.prs[1]!.hasMergeConflict = true;
    const detail = mergeProjectSnapshotIntoWorkspaceDetail(entry, seedDetail(existing));
    expect(detail).toMatchObject({
      prHasMergeConflict: true,
      statusReason: { code: 'PR_UPDATE_QUEUED' },
      kanbanColumn: 'WAITING',
    });
  });

  it('gives a newly synthesized PR a distinct identity from a cached legacy PR', () => {
    const existing = projectSnapshotToWorkspace(makeEntry());
    const entry = makeEntry({
      prs: [],
      prUrl: 'https://github.com/org/repo/pull/43',
      prNumber: 43,
    });
    const listed = projectSnapshotToWorkspace(entry, existing);
    expect(listed.prs.map((pr) => pr.id)).toEqual([
      'legacy-pr-ws-1',
      'legacy-pr-ws-1-https://github.com/org/repo/pull/43',
    ]);
  });

  it('does not preserve a legacy attachment after a snapshot explicitly removes it', () => {
    const existing = projectSnapshotToWorkspace(makeEntry());
    const entry = makeEntry({ prs: [], prUrl: null, prNumber: null, prState: 'NONE' });
    expect(projectSnapshotToWorkspace(entry, existing).prs).toEqual([]);
    expect(mergeProjectSnapshotIntoWorkspaceDetail(entry, seedDetail(existing))?.prs).toEqual([]);
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
      initErrorMessage: 'setup failed once',
      worktreePath: '/tmp/existing-worktree',
    };

    expect(projectSnapshotToWorkspace(entry, existing)).toMatchObject({
      name: 'snapshot-name',
      githubIssueNumber: 1959,
      githubIssueUrl: 'https://github.com/purplefish-ai/factory-factory/issues/1959',
      linearIssueId: 'linear-id',
      linearIssueIdentifier: 'ENG-1959',
      linearIssueUrl: 'https://linear.app/issue/ENG-1959',
      creationSource: 'CHILD_WORKSPACE',
      initErrorMessage: 'setup failed once',
      worktreePath: '/tmp/existing-worktree',
    });
  });

  it('projects mode from the snapshot entry rather than the existing cache row', () => {
    const entry = makeEntry({ mode: 'AUTO_ITERATION' });
    const existing: ProjectWorkspace = {
      ...projectSnapshotToWorkspace(makeEntry({ mode: 'STANDARD' })),
      mode: 'STANDARD',
    };

    expect(projectSnapshotToWorkspace(entry, existing).mode).toBe('AUTO_ITERATION');
  });

  it('supplies mutation-only defaults for a workspace the snapshot introduces first', () => {
    expect(projectSnapshotToWorkspace(makeEntry())).toMatchObject({
      creationSource: 'MANUAL',
      worktreePath: null,
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
