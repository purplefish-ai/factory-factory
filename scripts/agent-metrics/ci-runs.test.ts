import { describe, expect, it } from 'vitest';
import {
  attemptFromApi,
  attemptsFromRunList,
  type CiRunAttempt,
  ciMetrics,
  failedThenPassedCommits,
  firstRunOutcome,
  pushesPerBranch,
  runAttemptSchema,
  runListSchema,
  successfulDurationMinutes,
} from './ci-runs';

let nextRunId = 1;

function attempt(
  branch: string,
  sha: string,
  conclusion: string,
  startedAt: string,
  overrides: Partial<CiRunAttempt> = {}
): CiRunAttempt {
  const runId = nextRunId;
  nextRunId += 1;
  return {
    runId,
    attempt: 1,
    branch,
    sha,
    status: 'completed',
    conclusion,
    startedAt,
    updatedAt: startedAt,
    ...overrides,
  };
}

describe('CI run metrics', () => {
  it('passes over a cancelled first run and counts the first real outcome', () => {
    const outcome = firstRunOutcome([
      attempt('cancelled-then-green', 'a1', 'cancelled', '2026-11-01T10:00:00Z'),
      attempt('cancelled-then-green', 'a2', 'success', '2026-11-01T10:05:00Z'),
      attempt('cancelled-then-green', 'a3', 'failure', '2026-11-01T10:10:00Z'),
      attempt('red-then-green', 'b2', 'success', '2026-11-01T11:10:00Z'),
      attempt('red-then-green', 'b1', 'failure', '2026-11-01T11:00:00Z'),
      attempt('green', 'c1', 'success', '2026-11-01T12:00:00Z'),
    ]);
    expect(outcome).toEqual({
      branches: 3,
      decided: 3,
      greenOnFirstRun: 2,
      greenShare: 0.6667,
      branchesWithFailure: 2,
    });
  });

  it('leaves a branch undecided while its first real run is in progress or all are cancelled', () => {
    const outcome = firstRunOutcome([
      attempt('running', 'd1', '', '2026-11-01T10:00:00Z', { status: 'in_progress' }),
      attempt('running', 'd2', 'success', '2026-11-01T10:05:00Z'),
      attempt('only-cancelled', 'e1', 'cancelled', '2026-11-01T10:00:00Z'),
    ]);
    expect(outcome).toMatchObject({ branches: 2, decided: 0, greenOnFirstRun: 0 });
    expect(outcome.greenShare).toBeNull();
  });

  it('counts a failed first attempt even when the re-run went green', () => {
    const latest = attempt('rerun', 'f1', 'success', '2026-11-01T10:20:00Z', { attempt: 2 });
    const first = {
      ...latest,
      attempt: 1,
      conclusion: 'failure',
      startedAt: '2026-11-01T10:00:00Z',
    };
    expect(firstRunOutcome([latest, first])).toMatchObject({
      greenOnFirstRun: 0,
      branchesWithFailure: 1,
    });
    expect(failedThenPassedCommits([latest, first])).toBe(1);
  });

  it('counts distinct pushed commits per branch, including a PR with one push', () => {
    expect(
      pushesPerBranch([
        attempt('one-push', 'g1', 'success', '2026-11-01T10:00:00Z'),
        attempt('one-push', 'g1', 'success', '2026-11-01T10:30:00Z', { attempt: 2 }),
        attempt('three-pushes', 'h1', 'failure', '2026-11-01T10:00:00Z'),
        attempt('three-pushes', 'h2', 'failure', '2026-11-01T10:10:00Z'),
        attempt('three-pushes', 'h3', 'success', '2026-11-01T10:20:00Z'),
      ])
    ).toEqual({ count: 2, median: 2, p90: 2.8 });
  });

  it('measures successful completed runs only, in minutes', () => {
    expect(
      successfulDurationMinutes([
        attempt('x', 'i1', 'success', '2026-11-01T10:00:00Z', {
          updatedAt: '2026-11-01T10:07:00Z',
        }),
        attempt('x', 'i2', 'success', '2026-11-01T11:00:00Z', {
          updatedAt: '2026-11-01T11:05:00Z',
        }),
        attempt('x', 'i3', 'failure', '2026-11-01T12:00:00Z', {
          updatedAt: '2026-11-01T12:30:00Z',
        }),
      ])
    ).toEqual({ count: 2, median: 6, p90: 6.8 });
  });

  it('counts commits that failed and later passed, not passed then failed', () => {
    expect(
      failedThenPassedCommits([
        attempt('x', 'flaky', 'failure', '2026-11-01T10:00:00Z'),
        attempt('x', 'flaky', 'cancelled', '2026-11-01T10:05:00Z'),
        attempt('x', 'flaky', 'success', '2026-11-01T10:10:00Z'),
        attempt('y', 'regressed', 'success', '2026-11-01T10:00:00Z'),
        attempt('y', 'regressed', 'failure', '2026-11-01T10:10:00Z'),
        attempt('z', 'broken', 'failure', '2026-11-01T10:00:00Z'),
      ])
    ).toBe(1);
  });

  it('summarizes runs, attempts and the window', () => {
    const metrics = ciMetrics([
      attempt('x', 'j1', 'success', '2026-11-02T10:00:00Z'),
      attempt('y', 'j2', 'success', '2026-11-01T10:00:00Z'),
    ]);
    expect(metrics).toMatchObject({
      runs: 2,
      attempts: 2,
      window: { from: '2026-11-01T10:00:00Z', to: '2026-11-02T10:00:00Z' },
    });
  });

  it('validates gh run list and run attempt JSON', () => {
    const rows = runListSchema.parse([
      {
        databaseId: 42,
        attempt: 2,
        headBranch: 'feature',
        headSha: 'abc',
        status: 'completed',
        conclusion: 'success',
        startedAt: '2026-11-01T10:00:00Z',
        updatedAt: '2026-11-01T10:07:00Z',
      },
    ]);
    expect(attemptsFromRunList(rows)).toEqual([
      {
        runId: 42,
        attempt: 2,
        branch: 'feature',
        sha: 'abc',
        status: 'completed',
        conclusion: 'success',
        startedAt: '2026-11-01T10:00:00Z',
        updatedAt: '2026-11-01T10:07:00Z',
      },
    ]);
    expect(
      attemptFromApi(
        runAttemptSchema.parse({
          id: 42,
          run_attempt: 1,
          head_branch: 'feature',
          head_sha: 'abc',
          status: 'completed',
          conclusion: 'failure',
          run_started_at: '2026-11-01T09:50:00Z',
          updated_at: '2026-11-01T09:55:00Z',
        })
      )
    ).toMatchObject({ runId: 42, attempt: 1, conclusion: 'failure' });
    expect(runListSchema.safeParse([{ databaseId: 'nope' }]).success).toBe(false);
  });
});
