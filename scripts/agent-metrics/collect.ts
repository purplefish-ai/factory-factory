import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { countPhysicalLines } from '../check-file-length';
import {
  type BaselineSizes,
  baselineSizes,
  isLintRuleExceptionsFile,
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
import { commitFilesFormat, parseBlobBatch, parseCommitFiles, parseTreeBlobs } from './git-output';
import {
  type MergedPullRequest,
  mergedPullRequestListSchema,
  type PullRequestMetrics,
  pullRequestMetrics,
} from './pull-requests';
import { keywordInstructionMarker, templatePath } from './sandbox-section';
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
// `git cat-file --batch` returns every measured file of the commit at once.
const maxBuffer = 256 * 1024 * 1024;

const baselinePaths = {
  unusedCode: 'scripts/unused-code-baseline.json',
  fileLength: 'scripts/file-length-baseline.json',
};

/** `gh repo view --json nameWithOwner`. */
const repositorySchema = z.object({ nameWithOwner: z.string().regex(/^[\w.-]+\/[\w.-]+$/) });

/** `git log --format=%cI`: strict ISO 8601 with the committer's offset. */
const commitDateSchema = z.iso.datetime({ offset: true });

export type MetricsOptions = {
  pullRequests: number;
  /** Print the JSON instead of the Markdown. */
  json: boolean;
  /** Also write the JSON to this file. */
  jsonFile: string | null;
};

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
  /** 2: `followUpFixes.share` became `shareOfMerged`. 3: `sandboxSection` split by cut-off. */
  version: 3;
  github: { ci: CiMetrics; pullRequests: PullRequestMetrics };
  tree: TreeMetrics;
};

export function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', maxBuffer });
}

/**
 * One `gh` or `git` invocation in the repository, given optional standard input
 * and returning standard output as bytes. Tests pass fakes.
 */
export type Command = (args: readonly string[], input?: string) => Buffer;

function commandIn(command: 'gh' | 'git', root: string): Command {
  return (args, input) => execFileSync(command, args, { cwd: root, input, maxBuffer });
}

function parseJson<T>(schema: z.ZodType<T>, output: Buffer, source: string): T {
  const parsed = schema.safeParse(JSON.parse(output.toString('utf8')));
  if (!parsed.success) {
    throw new Error(`Unexpected ${source} output: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function collectCiAttempts(
  root: string,
  runCount: number,
  gh: Command = commandIn('gh', root)
): CiRunAttempt[] {
  const rows = parseJson(
    runListSchema,
    gh([
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
    ]),
    'gh run list'
  );
  // `gh run list` shows only a run's latest attempt; fetch the earlier ones so
  // a failure that was re-run green still counts.
  const earlier = rows.flatMap((row) =>
    Array.from({ length: row.attempt - 1 }, (_, index) =>
      attemptFromApi(
        parseJson(
          runAttemptSchema,
          gh(['api', `repos/{owner}/{repo}/actions/runs/${row.databaseId}/attempts/${index + 1}`]),
          'gh api run attempt'
        ),
        row.headBranch
      )
    )
  );
  return [...attemptsFromRunList(rows), ...earlier];
}

function collectMergedPullRequests(gh: Command, count: number): MergedPullRequest[] {
  return parseJson(
    mergedPullRequestListSchema,
    gh([
      'pr',
      'list',
      '--state',
      'merged',
      '--limit',
      String(count),
      '--json',
      'number,title,body,createdAt,mergedAt',
    ]),
    'gh pr list'
  );
}

/** `owner/name` of the repository `gh` works against. */
function collectRepository(gh: Command): string {
  return parseJson(
    repositorySchema,
    gh(['repo', 'view', '--json', 'nameWithOwner']),
    'gh repo view'
  ).nameWithOwner;
}

/** Files touched by each of the last `count` commits up to `revision`, newest first. */
export function collectCommitFiles(
  root: string,
  count: number,
  git: Command = commandIn('git', root),
  revision = 'HEAD'
): string[][] {
  return parseCommitFiles(
    git([
      'log',
      '-z',
      `-n${count}`,
      `--format=${commitFilesFormat}`,
      '--name-only',
      '--no-renames',
      revision,
    ])
  );
}

function isMeasured(path: string): boolean {
  return (
    isGuideFile(path) ||
    isArchitectureNote(path) ||
    isProductionSource(path) ||
    isSourceTest(path) ||
    path === sessionModulesPath ||
    isLintRuleExceptionsFile(path) ||
    Object.values(baselinePaths).includes(path)
  );
}

/**
 * When the template first asked for a keyword: the commit date of the oldest
 * commit up to `revision` that added or removed the keyword instruction. A
 * pull request opened since could see the instruction; the commit date of a
 * squash-merged commit is its merge time.
 */
export function collectKeywordInstructionAt(git: Command, revision: string): string {
  // In a shallow clone the oldest commit "adds" every file, so the search would
  // answer with the tip's date instead of failing.
  if (git(['rev-parse', '--is-shallow-repository']).toString('utf8').trim() === 'true') {
    throw new Error(
      'The keyword cut-off needs the full history; run `git fetch --unshallow` (or check out with `fetch-depth: 0`).'
    );
  }
  const first = git([
    'log',
    '--reverse',
    '--format=%cI',
    `-S${keywordInstructionMarker}`,
    revision,
    '--',
    templatePath,
  ])
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const parsed = commitDateSchema.safeParse(first);
  if (!parsed.success) {
    throw new Error(
      `No commit adds "${keywordInstructionMarker}" to ${templatePath} up to ${revision}: the template may have been renamed or the keyword instruction was removed.`
    );
  }
  return new Date(parsed.data).toISOString().replace('.000Z', 'Z');
}

/** Reads the HEAD commit (its file list and contents), never the working tree. */
export function collectTree(root: string, git: Command = commandIn('git', root)): TreeMetrics {
  const commit = git(['rev-parse', '--verify', 'HEAD^{commit}']).toString('utf8').trim();
  const blobs = parseTreeBlobs(git(['ls-tree', '-r', '-z', '--full-tree', commit]));
  const paths = blobs.map((blob) => blob.path);
  const measured = blobs.filter((blob) => isMeasured(blob.path));
  const contents = parseBlobBatch(
    git(['cat-file', '--batch'], measured.map((blob) => `${blob.objectId}\n`).join(''))
  );
  if (contents.length !== measured.length) {
    throw new Error(`git cat-file returned ${contents.length} of ${measured.length} files.`);
  }
  const files = new Map(measured.map((blob, index) => [blob.path, contents[index] ?? '']));
  const read = (path: string): TreeFile => {
    const content = files.get(path);
    if (content === undefined) {
      throw new Error(`${path} is not in commit ${commit}.`);
    }
    return { path, content };
  };
  const lines = (file: TreeFile): FileLines => ({
    path: file.path,
    lines: countPhysicalLines(file.content),
  });
  const readJson = (path: string): unknown => JSON.parse(read(path).content);

  const guides = paths.filter(isGuideFile).map(read);
  const source = paths.filter(isProductionSource).map(read).map(lines);
  const commits = collectCommitFiles(root, mostEditedCommitCount, git, commit);
  const large = largeFiles(source);

  return {
    commit,
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
      readJson(baselinePaths.unusedCode),
      readJson(baselinePaths.fileLength),
      paths.filter(isLintRuleExceptionsFile).map(read)
    ),
    sessionModuleCycles: sessionModuleCycleCount(files.get(sessionModulesPath) ?? null),
  };
}

export function collectAgentMetrics(
  root: string,
  options: MetricsOptions,
  gh: Command = commandIn('gh', root),
  git: Command = commandIn('git', root)
): AgentMetrics {
  const tree = collectTree(root, git);
  return {
    version: 3,
    github: {
      ci: ciMetrics(collectCiAttempts(root, options.pullRequests * runsPerPullRequest, gh)),
      pullRequests: pullRequestMetrics(
        collectMergedPullRequests(gh, options.pullRequests),
        collectRepository(gh),
        collectKeywordInstructionAt(git, tree.commit)
      ),
    },
    tree,
  };
}
