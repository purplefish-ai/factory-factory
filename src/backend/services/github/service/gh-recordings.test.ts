import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Every Zod schema that reads `gh` output parses the real output of its call,
// recorded by `node scripts/record-upstream.mjs gh` and scrubbed (task 2.10).
// The production code runs against the recordings through a fake `gh` that
// answers only the exact arguments that were recorded, so a recording also
// proves the call shape. A new parse site in this capsule fails the inventory
// test until it is mapped to a recording or listed with a reason.

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: (fn: unknown) => fn }));
vi.mock('@/backend/lib/shell', () => ({ execCommand: vi.fn() }));

import { execFile } from 'node:child_process';
import { execCommand } from '@/backend/lib/shell';
import { githubIssuePreviewSchema } from '@/shared/github-issue-preview';
import { githubPRPreviewSchema } from '@/shared/github-pr-preview';
import { githubCLIService } from './github-cli.service';
import { checkGithubAuth } from './github-cli/auth-check';
import { getPRDescription, getPRHeadCommitSha } from './github-cli/code-review';
import {
  fullPRDetailsSchema,
  issueListItemSchema,
  issueSchema,
  issueSearchResultSchema,
  openPullRequestsGraphQLSchema,
  prObservationDetailsSchema,
  prStatusDetailsSchema,
  resolvedReviewThreadsGraphQLSchema,
  reviewCommentSchema,
  reviewRequestedPRGraphQLSchema,
  reviewThreadCommentsGraphQLSchema,
} from './github-cli/schemas';
import { prObservationService } from './pr-observation.service';

const REPO = 'example-owner/example-repo';
const [OWNER, NAME] = ['example-owner', 'example-repo'];
const recordingsRoot = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'testing',
  'fixtures',
  'upstream',
  'gh'
);

const fixtureSchema = z.object({
  description: z.string(),
  deviation: z.string().optional(),
  args: z.array(z.string()),
  exitCode: z.number().int(),
  stdoutFormat: z.enum(['text', 'json', 'http-json']),
  stdout: z.unknown(),
  stderr: z.string(),
});
const httpSchema = z.object({
  head: z.object({
    status: z.string(),
    headers: z.array(z.tuple([z.string(), z.string()])),
    lineEnding: z.enum(['\n', '\r\n']),
  }),
  body: z.unknown(),
});
type Fixture = z.infer<typeof fixtureSchema> & { file: string; stdoutText: string };

function stdoutText(fixture: z.infer<typeof fixtureSchema>): string {
  if (fixture.stdoutFormat === 'text') {
    return z.string().parse(fixture.stdout);
  }
  if (fixture.stdoutFormat === 'json') {
    return JSON.stringify(fixture.stdout);
  }
  const { head, body } = httpSchema.parse(fixture.stdout);
  const lines = [head.status, ...head.headers.map(([name, value]) => `${name}: ${value}`)];
  return lines.join(head.lineEnding) + head.lineEnding + head.lineEnding + JSON.stringify(body);
}

/** Whitespace inside a GraphQL query is not part of the call shape. */
const callKey = (args: readonly string[]) =>
  args.map((arg) => arg.replace(/\s+/g, ' ').trim()).join('\u0000');

/**
 * The recording drops `review-requested:@me` from the review-request search so
 * it reads no account data (see the fixture's `deviation`); the application's
 * call matches it once the qualifier is removed.
 */
const recordedCallKey = (args: readonly string[]) =>
  callKey(args.map((arg) => arg.replace(' review-requested:@me', '')));

function loadVersion(directory: string): Fixture[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json') && file !== 'meta.json')
    .map((file) => {
      const fixture = fixtureSchema.parse(JSON.parse(readFileSync(join(directory, file), 'utf8')));
      return { ...fixture, file, stdoutText: stdoutText(fixture) };
    });
}

/** Parse sites of `gh` output in this capsule, by `parseGhJson` context or `file:schema`. */
function parseSites(): string[] {
  const sources = readdirSync(import.meta.dirname, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => ({
      name: basename(file),
      text: readFileSync(join(import.meta.dirname, file), 'utf8'),
    }));
  const sites = new Set<string>();
  for (const { name, text } of sources) {
    for (const match of text.matchAll(/parseGhJson\(\s*[^,]+?,\s*\w+,\s*'([^']+)'/g)) {
      sites.add(`parseGhJson:${match[1]}`);
    }
    for (const match of text.matchAll(/\b(\w+Schema)(?:\.\w+)*\s*\.(?:safeParse|parse)\(/g)) {
      sites.add(`${name}:${match[1]}`);
    }
    // An inline schema: `z.object({...}).parse(parseProviderJson(...))`.
    for (const match of text.matchAll(
      /\)\s*\.parse\(\s*((?:parseProviderJson|JSON\.parse)\([^;]*)\);/g
    )) {
      sites.add(`${name}:${match[1]?.replace(/\s+/g, ' ')}`);
    }
  }
  return [...sites].sort();
}

/** Each parse site of `gh` output and the recording it parses. */
const RECORDED: Record<string, string> = {
  'parseGhJson:getPRPreview': 'pr-view-preview.json',
  'parseGhJson:getPRStatusDetails': 'pr-view-status.json',
  'parseGhJson:getPRObservationDetails': 'pr-view-observation.json',
  'parseGhJson:getPRFullDetails': 'pr-view-full.json',
  'parseGhJson:getChronologicalReviews': 'api-pr-reviews.json',
  'parseGhJson:getReviewComments': 'api-pr-review-comments.json',
  'parseGhJson:getResolvedReviewCommentIds': 'graphql-review-threads.json',
  'parseGhJson:fetchThreadCommentsPage': 'graphql-thread-comments.json',
  'parseGhJson:listOpenPRs': 'graphql-open-prs.json',
  'review-requests.ts:reviewRequestedPRGraphQLSchema': 'graphql-review-requests.json',
  'parseGhJson:getIssuePreview': 'issue-view-preview.json',
  'parseGhJson:getIssue': 'issue-view.json',
  'parseGhJson:listIssues': 'issue-list.json',
  'parseGhJson:searchIssues': 'issue-list-search.json',
  'parseGhJson:searchIssueNumber': 'api-issue.json',
  'agent-sources.ts:repositorySchema': 'api-repo.json',
  'agent-issue-events.ts:parseProviderJson(result.stdout)': 'api-repo.json',
  'agent-sources.ts:labelsSchema': 'api-repo-labels.json',
  'agent-issue-events.ts:parseProviderJson(result.stdout.slice(separator.index + separator[0].length))':
    'api-issue-events.json',
  'agent-issue-events.ts:controlSchema': 'api-issue-events.json',
  'agent-issue-events.ts:executableSchema': 'api-issue-events.json',
  'agent-issue-events.ts:agentIssueEventPageSchema': 'api-issue-events.json',
  'pr-observation.service.ts:prObservationSchema': 'pr-view-observation.json',
};

/** Parse sites that read no `gh` output. */
const NOT_GH_OUTPUT: Record<string, string> = {
  'agent-sources.ts:githubIssuePreviewInputSchema': 'validates the repository name passed in',
  'review-requests.ts:githubPRPreviewInputSchema': 'validates the repository name passed in',
  'agent-issue-events.ts:githubIssuePreviewInputSchema': 'validates the repository name passed in',
  'agent-issue-events.ts:agentSourcePageNumberSchema': 'validates the page number passed in',
};

/** Recordings of calls whose output no schema reads; their readers are driven below. */
const RECORDED_WITHOUT_SCHEMA: Record<string, string> = {
  'version.json': 'the health check reads the version with a regular expression',
  'auth-status.json': 'the health check reads the exit code; the badge a regular expression',
  'api-user-login.json': '`--jq .login` prints the login, read as trimmed text',
  'pr-view-body.json': '`--jq .body` prints the description, read as trimmed text',
  'pr-view-head-sha.json': '`--jq .headRefOid` prints the commit, read as trimmed text',
};

/** Read-only call shapes with no recording, and why. Writes are never recorded. */
const NOT_RECORDED: Record<string, string> = {
  'gh pr diff <n> --repo <repo>':
    'no schema reads it: the diff is passed on as text, and an allowlist of its lines keeps nothing',
  'gh issue list ... --assignee @me':
    "reads the recording account's assignments; output and schema are those of issue-list.json",
  'gh api repos/<repo>/pulls/<n>/comments?...&since=<time>&...':
    'the same output and schema as api-pr-review-comments.json, filtered by time',
  'gh auth status --active (ff setup)':
    'reads only the exit code; auth-status.json is the same call',
  'gh pr review <n> --repo <repo> --approve|--request-changes|--comment': 'writes',
  'gh pr comment <n> --repo <repo> --body <text>': 'writes',
  'gh issue comment <n> --repo <repo> --body <text>': 'writes',
  'gh api --method POST repos/<repo>/pulls/<n>/reviews --input <file>': 'writes',
  'gh api --method POST repos/<repo>/pulls/<n>/comments --input <file>': 'writes',
};

const versions = readdirSync(recordingsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
  .map((entry) => entry.name);

it('has a recording of gh output', () => {
  expect(versions.length).toBeGreaterThan(0);
  expect(Object.keys(NOT_RECORDED).length).toBeGreaterThan(0);
});

it('maps every parse site of gh output to a recording or a reason', () => {
  expect(parseSites()).toEqual(Object.keys({ ...RECORDED, ...NOT_GH_OUTPUT }).sort());
});

describe.each(versions)('gh %s recordings', (version) => {
  const fixtures = loadVersion(join(recordingsRoot, version));
  const byFile = new Map(fixtures.map((fixture) => [fixture.file, fixture]));
  const byCall = new Map(fixtures.map((fixture) => [callKey(fixture.args), fixture]));
  const used = new Set<string>();

  function recording(file: string): Fixture {
    const fixture = byFile.get(file);
    if (!fixture) {
      throw new Error(`gh ${version} has no recording ${file}`);
    }
    return fixture;
  }
  const json = (file: string) => JSON.parse(recording(file).stdoutText);

  function answer(args: readonly string[]) {
    const fixture = byCall.get(recordedCallKey(args));
    if (!fixture) {
      return Promise.reject(new Error(`No recording of gh ${args.join(' ')}`));
    }
    used.add(fixture.file);
    const output = { stdout: fixture.stdoutText, stderr: fixture.stderr };
    return fixture.exitCode === 0
      ? Promise.resolve(output)
      : Promise.reject(Object.assign(new Error('Command failed'), output));
  }

  beforeEach(() => {
    vi.resetAllMocks();
    githubCLIService.clearCaches();
    vi.mocked(execFile).mockImplementation(((command: string, args: string[]) =>
      command === 'gh'
        ? answer(args)
        : Promise.reject(new Error(`Unexpected ${command}`))) as never);
    vi.mocked(execCommand).mockImplementation((command, args) => {
      if (command !== 'gh') {
        return Promise.reject(new Error(`Unexpected ${command}`));
      }
      const fixture = byCall.get(callKey(args));
      if (!fixture) {
        return Promise.reject(new Error(`No recording of gh ${args.join(' ')}`));
      }
      used.add(fixture.file);
      return Promise.resolve({
        stdout: fixture.stdoutText,
        stderr: fixture.stderr,
        code: fixture.exitCode,
      });
    });
  });

  it('holds one recording per shape, each mapped to its reader', () => {
    const mapped = new Set([...Object.values(RECORDED), ...Object.keys(RECORDED_WITHOUT_SCHEMA)]);
    expect([...byFile.keys()].sort()).toEqual([...mapped].sort());
  });

  it('parses the health and login reads', async () => {
    await expect(githubCLIService.checkHealth(true)).resolves.toEqual({
      isInstalled: true,
      isAuthenticated: true,
      version,
    });
    const login = await githubCLIService.getAuthenticatedUsername();
    expect(login).toMatch(/^user-\d+$/);
    await expect(checkGithubAuth()).resolves.toEqual({ authenticated: true, user: login });
  });

  it('parses the pull request reads', async () => {
    const open = Number(recording('pr-view-status.json').args[2]);
    const merged = Number(recording('pr-view-full.json').args[2]);

    githubPRPreviewSchema.parse(json('pr-view-preview.json'));
    await expect(githubCLIService.getPRPreview(REPO, open)).resolves.toMatchObject({
      state: 'OPEN',
    });

    prStatusDetailsSchema.parse(json('pr-view-status.json'));
    const status = await githubCLIService.getPRStatusDetails(REPO, open);
    expect(status.number).toBe(open);
    expect(status.statusCheckRollup?.length).toBeGreaterThan(0);

    prObservationDetailsSchema.parse(json('pr-view-observation.json'));
    const observation = await githubCLIService.getPRObservationDetails(REPO, merged);
    expect(observation.comments.length).toBeGreaterThan(0);

    fullPRDetailsSchema.parse(json('pr-view-full.json'));
    const full = await githubCLIService.getPRFullDetails(REPO, merged);
    expect(full).toMatchObject({ number: merged, state: 'MERGED' });
    expect(full.reviews.length).toBeGreaterThan(0);

    await expect(githubCLIService.getPRReviews(REPO, merged)).resolves.toHaveLength(
      full.reviews.length
    );
    await expect(getPRDescription(REPO, merged)).resolves.toBe('<text>');
    await expect(getPRHeadCommitSha(REPO, open)).resolves.toMatch(/^fake-sha-\d+$/);
  });

  it('parses the review comment and thread reads, which still join', async () => {
    const merged = Number(recording('pr-view-full.json').args[2]);

    reviewCommentSchema.array().parse(json('api-pr-review-comments.json'));
    const comments = await githubCLIService.getReviewComments(REPO, merged);
    expect(comments.length).toBeGreaterThan(0);

    const threads = resolvedReviewThreadsGraphQLSchema.parse(json('graphql-review-threads.json'));
    const resolved = await githubCLIService.getResolvedReviewCommentIds(REPO, merged);
    expect(comments.filter((comment) => resolved.has(comment.id))).toHaveLength(comments.length);

    reviewThreadCommentsGraphQLSchema.parse(json('graphql-thread-comments.json'));
    const thread = threads.data.repository?.pullRequest?.reviewThreads.nodes[0];
    const cursor = thread?.comments.pageInfo.endCursor;
    expect(thread && cursor).toBeTruthy();
    // Private: the production code pages a thread only past 100 comments.
    const page = await githubCLIService['fetchThreadCommentsPage'](thread?.id ?? '', cursor ?? '');
    expect(page?.nodes).toEqual([]);
  });

  it('parses the observation built from the recorded reads', async () => {
    const merged = Number(recording('pr-view-full.json').args[2]);
    prObservationService.configure({
      findPR: () =>
        Promise.resolve({
          url: `https://github.com/${REPO}/pull/${merged}`,
          hasMergeConflict: false,
        }),
      readPolicy: () => Promise.resolve({ reviewTriggerMode: 'ALL_REVIEW_FEEDBACK' }),
    });
    const observation = await prObservationService.fetch({ workspaceId: 'w', prId: 'p' });
    expect(observation).toMatchObject({ number: merged, prState: 'MERGED', reviewsComplete: true });
  });

  it('parses the open pull request and review-request searches', async () => {
    openPullRequestsGraphQLSchema.parse(json('graphql-open-prs.json'));
    await expect(githubCLIService.listOpenPRs(OWNER, NAME)).resolves.not.toHaveLength(0);

    reviewRequestedPRGraphQLSchema.parse(json('graphql-review-requests.json'));
    // It returns an empty list rather than fail when the response does not parse.
    await expect(
      githubCLIService.listReviewRequests(REPO, { forceRefresh: true })
    ).resolves.not.toHaveLength(0);
  });

  it('parses the issue reads', async () => {
    const issue = Number(recording('issue-view.json').args[2]);

    githubIssuePreviewSchema.parse(json('issue-view-preview.json'));
    await expect(githubCLIService.getIssuePreview(REPO, issue)).resolves.toMatchObject({
      state: 'OPEN',
    });

    issueSchema.parse(json('issue-view.json'));
    // It returns null rather than fail.
    await expect(githubCLIService.getIssue(OWNER, NAME, issue)).resolves.toMatchObject({
      number: issue,
    });

    issueListItemSchema.array().parse(json('issue-list.json'));
    await expect(githubCLIService.listIssues(OWNER, NAME)).resolves.not.toHaveLength(0);

    const search = recording('issue-list-search.json');
    issueSearchResultSchema.array().parse(json('issue-list-search.json'));
    const query = search.args[search.args.indexOf('--search') + 1] ?? '';
    await expect(githubCLIService.searchIssues(OWNER, NAME, query)).resolves.not.toHaveLength(0);

    await expect(githubCLIService.searchIssues(OWNER, NAME, `#${issue}`)).resolves.toEqual([
      expect.objectContaining({ number: issue, state: 'OPEN' }),
    ]);
  });

  it('parses the event-automation repository, label and issue event reads', async () => {
    const repository = await githubCLIService.getAgentRepository(REPO);
    expect(repository.labels.length).toBeGreaterThan(0);
    const identity = await githubCLIService.getAgentRepositoryIdentity(REPO);
    expect(identity).toEqual({ id: repository.id, name: REPO });

    const events = recording('api-issue-events.json');
    const page = Number(/[?&]page=(\d+)/.exec(events.args[1] ?? '')?.[1]);
    const result = await githubCLIService.listAgentIssueEvents({
      repository: REPO,
      repositoryId: identity.id,
      page,
      perPage: 100,
    });
    expect(result.nextPage).toBe(page + 1);
    const labeled = result.events.flatMap((event) =>
      event.payload?.provider === 'GITHUB' ? [event.payload] : []
    );
    expect(labeled.length).toBeGreaterThan(0);
    expect(labeled[0]?.action).toBe('labeled');
    expect(labeled[0]?.issue.labels.length).toBeGreaterThan(0);
  });

  it('answers every recorded call from the production code', () => {
    // Runs after the reads above, in file order.
    expect([...used].sort()).toEqual([...byFile.keys()].sort());
  });
});
