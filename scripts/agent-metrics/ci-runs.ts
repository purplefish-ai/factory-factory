import { z } from 'zod';
import { type Distribution, distribution, share, type TimeWindow, timeWindow } from './statistics';

const timestamp = z.iso.datetime();

/** One row of `gh run list --json attempt,conclusion,databaseId,headBranch,headSha,startedAt,status,updatedAt`. */
export const runListSchema = z.array(
  z.object({
    databaseId: z.number().int(),
    attempt: z.number().int().positive(),
    headBranch: z.string(),
    headSha: z.string().min(1),
    status: z.string(),
    conclusion: z.string(),
    startedAt: timestamp,
    updatedAt: timestamp,
  })
);

/**
 * `gh api repos/{owner}/{repo}/actions/runs/<id>/attempts/<n>`, for runs that
 * were re-run. Its `head_branch` can be null, so the branch comes from the run.
 */
export const runAttemptSchema = z.object({
  id: z.number().int(),
  run_attempt: z.number().int().positive(),
  head_sha: z.string().min(1),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  run_started_at: timestamp,
  updated_at: timestamp,
});

/** One attempt of one CI run; a re-run contributes one record per attempt. */
export type CiRunAttempt = {
  runId: number;
  attempt: number;
  branch: string;
  sha: string;
  status: string;
  conclusion: string;
  startedAt: string;
  updatedAt: string;
};

export function attemptsFromRunList(rows: z.infer<typeof runListSchema>): CiRunAttempt[] {
  return rows.map((row) => ({
    runId: row.databaseId,
    attempt: row.attempt,
    branch: row.headBranch,
    sha: row.headSha,
    status: row.status,
    conclusion: row.conclusion,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
  }));
}

/** An earlier attempt of a run; `branch` is the run's `headBranch` from `gh run list`. */
export function attemptFromApi(
  row: z.infer<typeof runAttemptSchema>,
  branch: string
): CiRunAttempt {
  return {
    runId: row.id,
    attempt: row.run_attempt,
    branch,
    sha: row.head_sha,
    status: row.status ?? '',
    conclusion: row.conclusion ?? '',
    startedAt: row.run_started_at,
    updatedAt: row.updated_at,
  };
}

// A cancelled, skipped or approval-waiting run says nothing about the code, so
// it is passed over.
const noSignalConclusions = new Set(['cancelled', 'skipped', 'action_required']);
const failingConclusions = new Set(['failure', 'timed_out', 'startup_failure']);

function chronological(attempts: readonly CiRunAttempt[]): CiRunAttempt[] {
  return attempts.toSorted(
    (left, right) =>
      Date.parse(left.startedAt) - Date.parse(right.startedAt) ||
      left.runId - right.runId ||
      left.attempt - right.attempt
  );
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) {
      group.push(item);
    } else {
      groups.set(key(item), [item]);
    }
  }
  return groups;
}

export type FirstRunOutcome = {
  branches: number;
  /** Branches with a completed, non-cancelled run before any run still in progress. */
  decided: number;
  greenOnFirstRun: number;
  greenShare: number | null;
  branchesWithFailure: number;
};

export function firstRunOutcome(attempts: readonly CiRunAttempt[]): FirstRunOutcome {
  const branches = groupBy(attempts, (attempt) => attempt.branch);
  let decided = 0;
  let greenOnFirstRun = 0;
  let branchesWithFailure = 0;
  for (const branchAttempts of branches.values()) {
    if (branchAttempts.some((attempt) => failingConclusions.has(attempt.conclusion))) {
      branchesWithFailure += 1;
    }
    const first = chronological(branchAttempts).find(
      (attempt) => !noSignalConclusions.has(attempt.conclusion)
    );
    if (first?.status !== 'completed') {
      continue;
    }
    decided += 1;
    if (first.conclusion === 'success') {
      greenOnFirstRun += 1;
    }
  }
  return {
    branches: branches.size,
    decided,
    greenOnFirstRun,
    greenShare: share(greenOnFirstRun, decided),
    branchesWithFailure,
  };
}

/** Distinct head commits that ran CI on each branch: one per push. */
export function pushesPerBranch(attempts: readonly CiRunAttempt[]): Distribution {
  const branches = groupBy(attempts, (attempt) => attempt.branch);
  return distribution(
    [...branches.values()].map((group) => new Set(group.map((attempt) => attempt.sha)).size),
    1
  );
}

export function successfulDurationMinutes(attempts: readonly CiRunAttempt[]): Distribution {
  return distribution(
    attempts
      .filter((attempt) => attempt.status === 'completed' && attempt.conclusion === 'success')
      .map((attempt) => (Date.parse(attempt.updatedAt) - Date.parse(attempt.startedAt)) / 60_000),
    1
  );
}

/** Commits where a failed run (or attempt) was later followed by a green one. */
export function failedThenPassedCommits(attempts: readonly CiRunAttempt[]): number {
  let count = 0;
  for (const commitAttempts of groupBy(attempts, (attempt) => attempt.sha).values()) {
    let failed = false;
    for (const attempt of chronological(commitAttempts)) {
      if (failingConclusions.has(attempt.conclusion)) {
        failed = true;
      } else if (failed && attempt.conclusion === 'success') {
        count += 1;
        break;
      }
    }
  }
  return count;
}

export type CiMetrics = {
  runs: number;
  attempts: number;
  window: TimeWindow;
  firstRun: FirstRunOutcome;
  pushesPerBranch: Distribution;
  successfulDurationMinutes: Distribution;
  failedThenPassedCommits: number;
};

export function ciMetrics(attempts: readonly CiRunAttempt[]): CiMetrics {
  return {
    runs: new Set(attempts.map((attempt) => attempt.runId)).size,
    attempts: attempts.length,
    window: timeWindow(attempts.map((attempt) => attempt.startedAt)),
    firstRun: firstRunOutcome(attempts),
    pushesPerBranch: pushesPerBranch(attempts),
    successfulDurationMinutes: successfulDurationMinutes(attempts),
    failedThenPassedCommits: failedThenPassedCommits(attempts),
  };
}
