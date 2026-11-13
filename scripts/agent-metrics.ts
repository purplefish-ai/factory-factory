import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { z } from 'zod';
import { countPhysicalLines } from './check-file-length';
import { parseUnusedCodeBaseline } from './check-unused-code';

// Measures how agent-driven development is going: CI and pull request outcomes
// from `gh`, and guidance, churn and test-structure sizes from the tree. The
// pure functions below take parsed data so tests need no network or checkout.

const usage = 'Usage: pnpm metrics:agents [--prs <count>] [--json]';
const defaultPullRequestCount = 300;
// Each merged PR has about two CI runs, so twice the PR count covers the same
// period of CI history.
const runsPerPullRequest = 2;
const mostEditedCommitCount = 300;
const mostEditedFileCount = 10;
const largeFileLines = 900;
const followUpWindowMs = 7 * 24 * 60 * 60 * 1000;
const sessionModulesPath = 'src/backend/services/session/modules.ts';

// ---------------------------------------------------------------------------
// Arguments

export type MetricsOptions = { pullRequests: number; json: boolean };

const pullRequestCountSchema = z.coerce.number().int().positive();

export function parseMetricsArgs(args: readonly string[]): MetricsOptions {
  const options: MetricsOptions = { pullRequests: defaultPullRequestCount, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--prs') {
      const parsed = pullRequestCountSchema.safeParse(args[index + 1]);
      if (!parsed.success) {
        throw new Error(`--prs needs a positive integer.\n${usage}`);
      }
      options.pullRequests = parsed.data;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage}`);
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// Statistics

export type Distribution = { count: number; median: number | null; p90: number | null };

/** Linear interpolation between closest ranks (the common spreadsheet definition). */
export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = values.toSorted((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

export function distribution(values: readonly number[], decimals: number): Distribution {
  const round = (value: number | null) => (value === null ? null : Number(value.toFixed(decimals)));
  return {
    count: values.length,
    median: round(percentile(values, 0.5)),
    p90: round(percentile(values, 0.9)),
  };
}

function share(part: number, whole: number): number | null {
  return whole === 0 ? null : Number((part / whole).toFixed(4));
}

// ---------------------------------------------------------------------------
// GitHub: CI runs

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

/** `gh api repos/{owner}/{repo}/actions/runs/<id>/attempts/<n>`, for runs that were re-run. */
export const runAttemptSchema = z.object({
  id: z.number().int(),
  run_attempt: z.number().int().positive(),
  head_branch: z.string().nullable(),
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

export function attemptFromApi(row: z.infer<typeof runAttemptSchema>): CiRunAttempt {
  return {
    runId: row.id,
    attempt: row.run_attempt,
    branch: row.head_branch ?? '',
    sha: row.head_sha,
    status: row.status ?? '',
    conclusion: row.conclusion ?? '',
    startedAt: row.run_started_at,
    updatedAt: row.updated_at,
  };
}

// A cancelled or skipped run says nothing about the code, so it is passed over.
const noSignalConclusions = new Set(['cancelled', 'skipped']);
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

export type TimeWindow = { from: string | null; to: string | null };

function timeWindow(stamps: readonly string[]): TimeWindow {
  const sorted = stamps.toSorted((left, right) => Date.parse(left) - Date.parse(right));
  return { from: sorted[0] ?? null, to: sorted.at(-1) ?? null };
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

// ---------------------------------------------------------------------------
// GitHub: merged pull requests

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

// ---------------------------------------------------------------------------
// Tree

export type TreeFile = { path: string; content: string };

function directoryOf(path: string): string {
  const directory = posix.dirname(path);
  return directory === '.' ? '' : directory;
}

function isWithin(directory: string, ancestor: string): boolean {
  return ancestor === '' || directory === ancestor || directory.startsWith(`${ancestor}/`);
}

/** Rough token estimate: four bytes per token. */
export function estimateTokens(content: string): number {
  return Math.round(Buffer.byteLength(content, 'utf8') / 4);
}

export function isGuideFile(path: string): boolean {
  return posix.basename(path) === 'AGENTS.md';
}

export type GuideChain = { directory: string; guides: string[]; lines: number; tokens: number };

/** For each directory with an `AGENTS.md`: that guide plus every ancestor guide. */
export function guideChains(guides: readonly TreeFile[]): GuideChain[] {
  return guides
    .map((guide) => directoryOf(guide.path))
    .toSorted()
    .map((directory) => {
      const chain = guides
        .filter((guide) => isWithin(directory, directoryOf(guide.path)))
        .toSorted((left, right) => left.path.length - right.path.length);
      return {
        directory: directory === '' ? '.' : directory,
        guides: chain.map((guide) => guide.path),
        lines: chain.reduce((total, guide) => total + countPhysicalLines(guide.content), 0),
        tokens: chain.reduce((total, guide) => total + estimateTokens(guide.content), 0),
      };
    });
}

export function isArchitectureNote(path: string): boolean {
  return path.startsWith('docs/architecture/') && path.endsWith('.md');
}

/** Non-test, non-story TypeScript under `src/`. */
export function isProductionSource(path: string): boolean {
  return (
    path.startsWith('src/') &&
    /\.tsx?$/.test(path) &&
    !/\.test\.tsx?$/.test(path) &&
    !/\.stories\.tsx?$/.test(path)
  );
}

export function isSourceTest(path: string): boolean {
  return path.startsWith('src/') && /\.test\.tsx?$/.test(path);
}

export type FileLines = { path: string; lines: number };

export type GuidanceSize = {
  guideLines: number;
  architectureNoteLines: number;
  guidanceLines: number;
  sourceLines: number;
  /** Guidance lines per 1,000 production source lines. */
  guidancePerThousandSourceLines: number | null;
};

export function guidanceSize(
  guides: readonly FileLines[],
  architectureNotes: readonly FileLines[],
  source: readonly FileLines[]
): GuidanceSize {
  const sum = (files: readonly FileLines[]) => files.reduce((total, file) => total + file.lines, 0);
  const guideLines = sum(guides);
  const architectureNoteLines = sum(architectureNotes);
  const sourceLines = sum(source);
  return {
    guideLines,
    architectureNoteLines,
    guidanceLines: guideLines + architectureNoteLines,
    sourceLines,
    guidancePerThousandSourceLines:
      sourceLines === 0
        ? null
        : Number((((guideLines + architectureNoteLines) / sourceLines) * 1000).toFixed(1)),
  };
}

export type EditedFile = { path: string; commits: number; share: number | null };

/** Takes the files touched by each commit, newest first. */
export function mostEditedFiles(
  commits: readonly (readonly string[])[],
  limit = mostEditedFileCount
): EditedFile[] {
  const counts = new Map<string, number>();
  for (const files of commits) {
    for (const path of new Set(files)) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  return [...counts]
    .toSorted(
      ([leftPath, left], [rightPath, right]) => right - left || leftPath.localeCompare(rightPath)
    )
    .slice(0, limit)
    .map(([path, count]) => ({ path, commits: count, share: share(count, commits.length) }));
}

export function largeFiles(files: readonly FileLines[], threshold = largeFileLines): FileLines[] {
  return files
    .filter((file) => file.lines >= threshold)
    .toSorted((left, right) => right.lines - left.lines || left.path.localeCompare(right.path));
}

export const mockTargetClasses = [
  'client modules',
  'npm and Node',
  'capsule barrels',
  'relative paths',
  'other backend',
  'root infrastructure services',
  'session internals',
  'workspace internals',
  'other capsule internals',
  'other',
] as const;

export type MockTargetClass = (typeof mockTargetClasses)[number];

const clientPrefixes = ['@/client/', '@/components/', '@/hooks/', '@/lib/'];

function classifyServiceTarget(
  name: string,
  rest: string,
  capsules: ReadonlySet<string>
): MockTargetClass {
  if (!capsules.has(name)) {
    return 'root infrastructure services';
  }
  if (rest === '' || rest === '/index') {
    return 'capsule barrels';
  }
  if (name === 'session') {
    return 'session internals';
  }
  return name === 'workspace' ? 'workspace internals' : 'other capsule internals';
}

/** `capsules` are the directories under `src/backend/services/` with an `index.ts`. */
export function classifyMockTarget(
  target: string | null,
  capsules: ReadonlySet<string>
): MockTargetClass {
  if (target === null) {
    return 'other';
  }
  if (target.startsWith('.')) {
    return 'relative paths';
  }
  if (clientPrefixes.some((prefix) => target.startsWith(prefix))) {
    return 'client modules';
  }
  const service = /^@\/backend\/services\/([^/]+)(\/.*)?$/.exec(target);
  if (service) {
    return classifyServiceTarget(service[1] ?? '', service[2] ?? '', capsules);
  }
  if (target.startsWith('@/backend/')) {
    return 'other backend';
  }
  if (target.startsWith('@/') || target.startsWith('@prisma-gen/') || target.startsWith('/')) {
    return 'other';
  }
  return 'npm and Node';
}

export function capsuleNames(paths: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const path of paths) {
    const match = /^src\/backend\/services\/([^/]+)\/index\.ts$/.exec(path);
    if (match?.[1]) {
      names.add(match[1]);
    }
  }
  return names;
}

export type ViMockCounts = {
  calls: number;
  filesWithMocks: number;
  testFiles: number;
  byTarget: Record<MockTargetClass, number>;
};

/** Counts `vi.mock(` calls; the target is the first argument when it is a string literal. */
export function viMockCounts(
  testFiles: readonly TreeFile[],
  capsules: ReadonlySet<string>
): ViMockCounts {
  const byTarget: Record<MockTargetClass, number> = {
    'client modules': 0,
    'npm and Node': 0,
    'capsule barrels': 0,
    'relative paths': 0,
    'other backend': 0,
    'root infrastructure services': 0,
    'session internals': 0,
    'workspace internals': 0,
    'other capsule internals': 0,
    other: 0,
  };
  let calls = 0;
  let filesWithMocks = 0;
  for (const file of testFiles) {
    const matches = [...file.content.matchAll(/\bvi\.mock\(\s*(?:(['"`])([^'"`]*)\1)?/g)];
    if (matches.length > 0) {
      filesWithMocks += 1;
    }
    for (const match of matches) {
      calls += 1;
      const target = match[1] === undefined ? null : (match[2] ?? null);
      const name = classifyMockTarget(target, capsules);
      byTarget[name] += 1;
    }
  }
  return { calls, filesWithMocks, testFiles: testFiles.length, byTarget };
}

const exceptionsSchema = z.record(z.string(), z.string());

/** Entries in every `exceptions` object of a lint configuration (`.oxlintrc.json`). */
export function lintExceptionEntries(config: unknown): number {
  if (Array.isArray(config)) {
    return config.reduce<number>((total, item) => total + lintExceptionEntries(item), 0);
  }
  if (typeof config !== 'object' || config === null) {
    return 0;
  }
  return Object.entries(config).reduce<number>(
    (total, [key, value]) =>
      total +
      (key === 'exceptions'
        ? Object.keys(exceptionsSchema.parse(value)).length
        : lintExceptionEntries(value)),
    0
  );
}

const fileLengthBaselineSchema = z.record(z.string(), z.number().int());

export type BaselineSizes = {
  unusedCodeProduction: number;
  unusedCodeExports: number;
  fileLength: number;
  lintExceptions: number;
};

export function baselineSizes(
  unusedCodeBaseline: unknown,
  fileLengthBaseline: unknown,
  lintConfig: unknown
): BaselineSizes {
  const unusedCode = parseUnusedCodeBaseline(unusedCodeBaseline);
  return {
    unusedCodeProduction: Object.keys(unusedCode.production).length,
    unusedCodeExports: Object.keys(unusedCode.exports).length,
    fileLength: Object.keys(fileLengthBaselineSchema.parse(fileLengthBaseline)).length,
    lintExceptions: lintExceptionEntries(lintConfig),
  };
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

/** Length of the exported `sessionModuleCycles` array; `null` while the file is absent. */
export function sessionModuleCycleCount(source: string | null): number | null {
  if (source === null) {
    return null;
  }
  const file = ts.createSourceFile(sessionModulesPath, source, ts.ScriptTarget.Latest, true);
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === 'sessionModuleCycles' &&
        declaration.initializer
      ) {
        const initializer = unwrapExpression(declaration.initializer);
        if (ts.isArrayLiteralExpression(initializer)) {
          return initializer.elements.length;
        }
      }
    }
  }
  throw new Error(`${sessionModulesPath} has no sessionModuleCycles array literal.`);
}

export type TreeMetrics = {
  commit: string;
  guideChains: GuideChain[];
  guidance: GuidanceSize;
  mostEditedFiles: { commits: number; files: EditedFile[] };
  largeProductionFiles: { threshold: number; count: number; files: FileLines[] };
  viMocks: ViMockCounts;
  baselines: BaselineSizes;
  sessionModuleCycles: number | null;
};

// ---------------------------------------------------------------------------
// Output

export type AgentMetrics = {
  version: 1;
  github: { ci: CiMetrics; pullRequests: PullRequestMetrics };
  tree: TreeMetrics;
};

function formatNumber(value: number | null, suffix = ''): string {
  return value === null ? 'n/a' : `${value.toLocaleString('en-US')}${suffix}`;
}

function formatShare(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatDistribution(value: Distribution, unit: string): string {
  return `median ${formatNumber(value.median, unit)}, p90 ${formatNumber(value.p90, unit)} (n=${value.count})`;
}

function formatWindow(window: TimeWindow): string {
  return `${window.from ?? 'n/a'} to ${window.to ?? 'n/a'}`;
}

export function renderMarkdown(metrics: AgentMetrics): string {
  const { ci, pullRequests } = metrics.github;
  const { tree } = metrics;
  const lines = [
    '# Agent workflow metrics',
    '',
    `Tree at \`${tree.commit}\`.`,
    '',
    '## Pull requests and CI',
    '',
    `CI: ${ci.runs} \`pull_request\` runs of \`ci.yml\` (${ci.attempts} attempts), started ${formatWindow(ci.window)}.`,
    `Pull requests: ${pullRequests.merged} merged, ${formatWindow(pullRequests.window)}.`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| PR branches green on first non-cancelled run | ${ci.firstRun.greenOnFirstRun} of ${ci.firstRun.decided} (${formatShare(ci.firstRun.greenShare)}) |`,
    `| PR branches with any failed run | ${ci.firstRun.branchesWithFailure} of ${ci.firstRun.branches} |`,
    `| Pushes per PR branch | ${formatDistribution(ci.pushesPerBranch, '')} |`,
    `| CI duration, successful runs | ${formatDistribution(ci.successfulDurationMinutes, ' min')} |`,
    `| Commits that failed then passed | ${ci.failedThenPassedCommits} |`,
    `| Open to merge | ${formatDistribution(pullRequests.openToMergeHours, ' h')} |`,
    `| Merged PRs titled with a fix verb | ${pullRequests.followUpFixes.fixTitled} of ${pullRequests.merged} |`,
    `| Fix PRs referencing a PR merged in the previous 7 days | ${pullRequests.followUpFixes.referencingRecentMerge} (${formatShare(pullRequests.followUpFixes.share)})${pullRequests.followUpFixes.numbers.length > 0 ? `: ${pullRequests.followUpFixes.numbers.map((number) => `#${number}`).join(', ')}` : ''} |`,
    '',
    '## Guidance',
    '',
    '| Directory | Guide chain | Lines | Estimated tokens |',
    '| --- | --- | --- | --- |',
    ...tree.guideChains.map(
      (chain) =>
        `| \`${chain.directory}\` | ${chain.guides.map((guide) => `\`${guide}\``).join(' → ')} | ${formatNumber(chain.lines)} | ${formatNumber(chain.tokens)} |`
    ),
    '',
    `Guidance: ${formatNumber(tree.guidance.guidanceLines)} lines (\`AGENTS.md\` ${formatNumber(tree.guidance.guideLines)}, \`docs/architecture\` ${formatNumber(tree.guidance.architectureNoteLines)}) against ${formatNumber(tree.guidance.sourceLines)} production source lines under \`src/\`: ${formatNumber(tree.guidance.guidancePerThousandSourceLines)} per 1,000.`,
    '',
    `## Most-edited files (last ${tree.mostEditedFiles.commits} commits)`,
    '',
    '| File | Commits | Share |',
    '| --- | --- | --- |',
    ...tree.mostEditedFiles.files.map(
      (file) => `| \`${file.path}\` | ${file.commits} | ${formatShare(file.share)} |`
    ),
    '',
    `## Production files of ${tree.largeProductionFiles.threshold} lines or more: ${tree.largeProductionFiles.count}`,
    '',
    ...tree.largeProductionFiles.files.map(
      (file) => `- \`${file.path}\`: ${formatNumber(file.lines)}`
    ),
    '',
    '## `vi.mock` calls',
    '',
    `${formatNumber(tree.viMocks.calls)} calls in ${formatNumber(tree.viMocks.filesWithMocks)} of ${formatNumber(tree.viMocks.testFiles)} test files under \`src/\`.`,
    '',
    '| Target | Calls |',
    '| --- | --- |',
    ...mockTargetClasses.map((name) => `| ${name} | ${tree.viMocks.byTarget[name]} |`),
    '',
    '## Baselines and exceptions',
    '',
    '| List | Entries |',
    '| --- | --- |',
    `| \`scripts/unused-code-baseline.json\` production | ${tree.baselines.unusedCodeProduction} |`,
    `| \`scripts/unused-code-baseline.json\` exports | ${tree.baselines.unusedCodeExports} |`,
    `| \`scripts/file-length-baseline.json\` | ${tree.baselines.fileLength} |`,
    `| \`.oxlintrc.json\` rule exceptions | ${tree.baselines.lintExceptions} |`,
    `| \`sessionModuleCycles\` | ${tree.sessionModuleCycles === null ? `n/a (no \`${sessionModulesPath}\`)` : tree.sessionModuleCycles} |`,
    '',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Collection (network and file system)

const maxBuffer = 64 * 1024 * 1024;

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', maxBuffer });
}

function parseJson<T>(schema: z.ZodType<T>, text: string, source: string): T {
  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`Unexpected ${source} output: ${parsed.error.message}`);
  }
  return parsed.data;
}

function collectCiAttempts(root: string, runCount: number): CiRunAttempt[] {
  const rows = parseJson(
    runListSchema,
    run(
      'gh',
      [
        'run',
        'list',
        '--workflow',
        'ci.yml',
        '--event',
        'pull_request',
        '--limit',
        String(runCount),
        '--json',
        'attempt,conclusion,databaseId,headBranch,headSha,startedAt,status,updatedAt',
      ],
      root
    ),
    'gh run list'
  );
  // `gh run list` shows only a run's latest attempt; fetch the earlier ones so
  // a failure that was re-run green still counts.
  const earlier = rows.flatMap((row) =>
    Array.from({ length: row.attempt - 1 }, (_, index) =>
      attemptFromApi(
        parseJson(
          runAttemptSchema,
          run(
            'gh',
            ['api', `repos/{owner}/{repo}/actions/runs/${row.databaseId}/attempts/${index + 1}`],
            root
          ),
          'gh api run attempt'
        )
      )
    )
  );
  return [...attemptsFromRunList(rows), ...earlier];
}

function collectMergedPullRequests(root: string, count: number): MergedPullRequest[] {
  return parseJson(
    mergedPullRequestListSchema,
    run(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'merged',
        '--limit',
        String(count),
        '--json',
        'number,title,body,createdAt,mergedAt',
      ],
      root
    ),
    'gh pr list'
  );
}

/** Files touched by each of the last `count` commits, newest first. */
function collectCommitFiles(root: string, count: number): string[][] {
  const output = run(
    'git',
    ['log', `-n${count}`, '--format=%x1e', '--name-only', '--no-renames', 'HEAD'],
    root
  );
  return output
    .split('\u001e')
    .slice(1)
    .map((block) => block.split('\n').filter((line) => line.length > 0));
}

function collectTree(root: string): TreeMetrics {
  const paths = run('git', ['ls-files', '-z'], root)
    .split('\0')
    .filter((path) => path.length > 0 && existsSync(resolve(root, path)));
  const read = (path: string): TreeFile => ({
    path,
    content: readFileSync(resolve(root, path), 'utf8'),
  });
  const lines = (file: TreeFile): FileLines => ({
    path: file.path,
    lines: countPhysicalLines(file.content),
  });
  const readJson = (path: string): unknown => JSON.parse(read(path).content);

  const guides = paths.filter(isGuideFile).map(read);
  const source = paths.filter(isProductionSource).map(read).map(lines);
  const commits = collectCommitFiles(root, mostEditedCommitCount);
  const large = largeFiles(source);
  const sessionModules = resolve(root, sessionModulesPath);

  return {
    commit: run('git', ['rev-parse', 'HEAD'], root).trim(),
    guideChains: guideChains(guides),
    guidance: guidanceSize(
      guides.map(lines),
      paths.filter(isArchitectureNote).map(read).map(lines),
      source
    ),
    mostEditedFiles: { commits: commits.length, files: mostEditedFiles(commits) },
    largeProductionFiles: { threshold: largeFileLines, count: large.length, files: large },
    viMocks: viMockCounts(paths.filter(isSourceTest).map(read), capsuleNames(paths)),
    baselines: baselineSizes(
      readJson('scripts/unused-code-baseline.json'),
      readJson('scripts/file-length-baseline.json'),
      readJson('.oxlintrc.json')
    ),
    sessionModuleCycles: sessionModuleCycleCount(
      existsSync(sessionModules) ? readFileSync(sessionModules, 'utf8') : null
    ),
  };
}

export function collectAgentMetrics(root: string, options: MetricsOptions): AgentMetrics {
  return {
    version: 1,
    github: {
      ci: ciMetrics(collectCiAttempts(root, options.pullRequests * runsPerPullRequest)),
      pullRequests: pullRequestMetrics(collectMergedPullRequests(root, options.pullRequests)),
    },
    tree: collectTree(root),
  };
}

function main() {
  const options = parseMetricsArgs(process.argv.slice(2));
  const root = run('git', ['rev-parse', '--show-toplevel'], process.cwd()).trim();
  const metrics = collectAgentMetrics(root, options);
  process.stdout.write(
    options.json ? `${JSON.stringify(metrics, null, 2)}\n` : renderMarkdown(metrics)
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `Agent metrics failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
