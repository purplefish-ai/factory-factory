import { describe, expect, it, vi } from 'vitest';
import { CIStatus, RatchetState } from '@/shared/core';
import type { PRStateInfo } from './ratchet.types';
import {
  computeCiSnapshotKey,
  computeDispatchSnapshotKey,
  determineRatchetState,
  shouldSkipCleanPR,
} from './ratchet-pr-state.helpers';

function makePRState(overrides: Partial<PRStateInfo> = {}): PRStateInfo {
  return {
    ciStatus: CIStatus.SUCCESS,
    snapshotKey: 'key',
    hasChangesRequested: false,
    hasMergeConflict: false,
    latestReviewActivityAtMs: null,
    statusCheckRollup: null,
    prState: 'OPEN',
    prNumber: 1,
    reviewComments: [],
    ...overrides,
  };
}

describe('determineRatchetState', () => {
  it('returns MERGED when prState is MERGED', () => {
    expect(determineRatchetState(makePRState({ prState: 'MERGED' }))).toBe(RatchetState.MERGED);
  });

  it('returns IDLE when prState is CLOSED', () => {
    expect(determineRatchetState(makePRState({ prState: 'CLOSED' }))).toBe(RatchetState.IDLE);
  });

  it('returns CI_FAILED when CI has failures', () => {
    expect(determineRatchetState(makePRState({ ciStatus: CIStatus.FAILURE }))).toBe(
      RatchetState.CI_FAILED
    );
  });

  it('returns MERGE_CONFLICT when hasMergeConflict is true and CI is passing', () => {
    expect(determineRatchetState(makePRState({ hasMergeConflict: true }))).toBe(
      RatchetState.MERGE_CONFLICT
    );
  });

  it('returns MERGE_CONFLICT over CI_RUNNING when conflicts and CI is pending', () => {
    expect(
      determineRatchetState(makePRState({ hasMergeConflict: true, ciStatus: CIStatus.PENDING }))
    ).toBe(RatchetState.MERGE_CONFLICT);
  });

  it('returns MERGE_CONFLICT over CI_RUNNING when conflicts and CI is unknown', () => {
    expect(
      determineRatchetState(makePRState({ hasMergeConflict: true, ciStatus: CIStatus.UNKNOWN }))
    ).toBe(RatchetState.MERGE_CONFLICT);
  });

  it('CI_FAILED takes priority over MERGE_CONFLICT', () => {
    expect(
      determineRatchetState(makePRState({ hasMergeConflict: true, ciStatus: CIStatus.FAILURE }))
    ).toBe(RatchetState.CI_FAILED);
  });

  it('returns CI_RUNNING when CI is pending and no conflicts', () => {
    expect(determineRatchetState(makePRState({ ciStatus: CIStatus.PENDING }))).toBe(
      RatchetState.CI_RUNNING
    );
  });

  it('returns REVIEW_PENDING when changes requested and CI passed', () => {
    expect(determineRatchetState(makePRState({ hasChangesRequested: true }))).toBe(
      RatchetState.REVIEW_PENDING
    );
  });

  it('returns READY when open, CI passed, no conflicts, no review requests', () => {
    expect(determineRatchetState(makePRState())).toBe(RatchetState.READY);
  });
});

describe('shouldSkipCleanPR', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as never;

  function makeWorkspace(
    overrides: { ratchetActiveSessionId: string | null } = { ratchetActiveSessionId: null }
  ) {
    return {
      id: 'ws-1',
      prReviewLastCheckedAt: new Date('2026-01-01T00:00:00Z'),
      ratchetActiveSessionId: overrides.ratchetActiveSessionId,
    } as never;
  }

  it('does not skip a PR with merge conflicts even when CI passes', () => {
    const prState = makePRState({ hasMergeConflict: true });
    expect(shouldSkipCleanPR(makeWorkspace(), prState, logger)).toBe(false);
  });

  it('skips a clean PR with no new review activity', () => {
    // ratchetActiveSessionId is non-null to suppress the self-heal stale-check path
    const prState = makePRState({
      latestReviewActivityAtMs: new Date('2025-12-31T00:00:00Z').getTime(),
    });
    expect(
      shouldSkipCleanPR(
        makeWorkspace({ ratchetActiveSessionId: 'active-session' }),
        prState,
        logger
      )
    ).toBe(true);
  });

  it('does not skip when CI is not passing', () => {
    const prState = makePRState({ ciStatus: CIStatus.FAILURE });
    expect(shouldSkipCleanPR(makeWorkspace(), prState, logger)).toBe(false);
  });

  it('does not skip when changes are requested', () => {
    const prState = makePRState({ hasChangesRequested: true });
    expect(shouldSkipCleanPR(makeWorkspace(), prState, logger)).toBe(false);
  });
});

describe('computeDispatchSnapshotKey', () => {
  it('includes merge:conflict suffix when hasMergeConflict is true', () => {
    const key = computeDispatchSnapshotKey(CIStatus.SUCCESS, false, null, null, true);
    expect(key).toContain('merge:conflict');
  });

  it('includes merge:clean suffix when hasMergeConflict is false', () => {
    const key = computeDispatchSnapshotKey(CIStatus.SUCCESS, false, null, null, false);
    expect(key).toContain('merge:clean');
  });

  it('produces different keys for conflicted vs clean PRs', () => {
    const clean = computeDispatchSnapshotKey(CIStatus.PENDING, false, null, null, false);
    const conflicted = computeDispatchSnapshotKey(CIStatus.PENDING, false, null, null, true);
    expect(clean).not.toBe(conflicted);
  });
});

describe('computeCiSnapshotKey', () => {
  it('ignores stale failures from superseded runs of the same check', () => {
    const key = computeCiSnapshotKey(CIStatus.FAILURE, [
      {
        name: 'ci',
        workflowName: 'CI',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        detailsUrl: 'https://github.com/org/repo/actions/runs/100/job/1',
      },
      {
        name: 'ci',
        workflowName: 'CI',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        detailsUrl: 'https://github.com/org/repo/actions/runs/101/job/1',
      },
      {
        name: 'commitlint',
        workflowName: 'CI',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        detailsUrl: 'https://github.com/org/repo/actions/runs/101/job/2',
      },
    ]);

    expect(key).toContain('commitlint:FAILURE');
    expect(key).not.toContain('ci:FAILURE:101');
  });
});
