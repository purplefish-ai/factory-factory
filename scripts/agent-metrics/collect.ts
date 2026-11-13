import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { z } from 'zod';
import { countPhysicalLines } from '../check-file-length';
import {
  type BaselineSizes,
  baselineSizes,
  sessionModuleCycleCount,
  sessionModulesPath,
} from './baselines';
import {
  attemptFromApi,
  attemptsFromRunList,
  type CiMetrics,
  type CiRunAttempt,
  ciMetrics,
  runAttemptSchema,
  runListSchema,
} from './ci-runs';
import {
  type MergedPullRequest,
  mergedPullRequestListSchema,
  type PullRequestMetrics,
  pullRequestMetrics,
} from './pull-requests';
import {
  type EditedFile,
  type FileLines,
  type GuidanceSize,
  type GuideChain,
  guidanceSize,
  guideChains,
  isArchitectureNote,
  isGuideFile,
  isProductionSource,
  isSourceTest,
  largeFileLines,
  largeFiles,
  mostEditedFiles,
  type TreeFile,
} from './tree';
import { capsuleNames, type ViMockCounts, viMockCounts } from './vi-mocks';

// Each merged PR has about two CI runs, so twice the PR count covers the same
// period of CI history.
const runsPerPullRequest = 2;
const mostEditedCommitCount = 300;
const maxBuffer = 64 * 1024 * 1024;

export type MetricsOptions = { pullRequests: number; json: boolean };

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

export type AgentMetrics = {
  version: 1;
  github: { ci: CiMetrics; pullRequests: PullRequestMetrics };
  tree: TreeMetrics;
};

export function run(command: string, args: readonly string[], cwd: string): string {
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
