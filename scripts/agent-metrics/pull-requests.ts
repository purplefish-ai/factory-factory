import { z } from 'zod';
import { type Distribution, distribution, share, type TimeWindow, timeWindow } from './statistics';

const followUpWindowMs = 7 * 24 * 60 * 60 * 1000;
const timestamp = z.iso.datetime();

/** One row of `gh pr list --state merged --json number,title,body,createdAt,mergedAt`. */
export const mergedPullRequestListSchema = z.array(
  z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string(),
    createdAt: timestamp,
    mergedAt: timestamp,
  })
);

export type MergedPullRequest = z.infer<typeof mergedPullRequestListSchema>[number];

export function openToMergeHours(pullRequests: readonly MergedPullRequest[]): Distribution {
  return distribution(
    pullRequests.map(
      (pullRequest) =>
        (Date.parse(pullRequest.mergedAt) - Date.parse(pullRequest.createdAt)) / 3_600_000
    ),
    2
  );
}

const fixVerbPattern =
  /^(?:fix(?:e[sd]|ing)?|repair(?:s|ed)?|restore[sd]?|recover(?:s|ed)?|correct(?:s|ed)?|revert(?:s|ed)?|resolve[sd]?|prevent(?:s|ed)?|stop(?:s|ped)?)\b/i;

export function startsWithFixVerb(title: string): boolean {
  return fixVerbPattern.test(title.trim());
}

/** Pull request numbers a body mentions as `#123` or as a `/pull/123` link. */
export function referencedPullRequestNumbers(body: string): number[] {
  const numbers = new Set<number>();
  for (const match of body.matchAll(/(?:^|[^\w&/])#(\d+)\b|\/pull\/(\d+)\b/g)) {
    numbers.add(Number(match[1] ?? match[2]));
  }
  return [...numbers].toSorted((left, right) => left - right);
}

export type FollowUpFixes = {
  fixTitled: number;
  /** Fix-titled PRs whose body references a PR merged in the 7 days before it merged. */
  referencingRecentMerge: number;
  share: number | null;
  numbers: number[];
};

export function followUpFixes(pullRequests: readonly MergedPullRequest[]): FollowUpFixes {
  const mergedAt = new Map(
    pullRequests.map((pullRequest) => [pullRequest.number, Date.parse(pullRequest.mergedAt)])
  );
  const fixes = pullRequests.filter((pullRequest) => startsWithFixVerb(pullRequest.title));
  const numbers = fixes
    .filter((pullRequest) => {
      const merged = Date.parse(pullRequest.mergedAt);
      return referencedPullRequestNumbers(pullRequest.body).some((number) => {
        const referenced = mergedAt.get(number);
        return (
          number !== pullRequest.number &&
          referenced !== undefined &&
          referenced <= merged &&
          merged - referenced <= followUpWindowMs
        );
      });
    })
    .map((pullRequest) => pullRequest.number)
    .toSorted((left, right) => left - right);
  return {
    fixTitled: fixes.length,
    referencingRecentMerge: numbers.length,
    share: share(numbers.length, pullRequests.length),
    numbers,
  };
}

export type PullRequestMetrics = {
  merged: number;
  window: TimeWindow;
  openToMergeHours: Distribution;
  followUpFixes: FollowUpFixes;
};

export function pullRequestMetrics(pullRequests: readonly MergedPullRequest[]): PullRequestMetrics {
  return {
    merged: pullRequests.length,
    window: timeWindow(pullRequests.map((pullRequest) => pullRequest.mergedAt)),
    openToMergeHours: openToMergeHours(pullRequests),
    followUpFixes: followUpFixes(pullRequests),
  };
}
