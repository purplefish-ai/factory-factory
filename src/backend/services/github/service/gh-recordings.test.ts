import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import ts from 'typescript';
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
 * call matches it once the qualifier is removed from that search's query.
 */
const recordedCallKey = (args: readonly string[]) =>
  callKey(
    args[0] === 'api' && args[1] === 'graphql'
      ? args.map((arg) =>
          /^query=\s*query\s*\{\s*search\(query:/.test(arg)
            ? arg.replace(' review-requested:@me', '')
            : arg
        )
      : args
  );

function loadVersion(directory: string): Fixture[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json') && file !== 'meta.json')
    .map((file) => {
      const fixture = fixtureSchema.parse(JSON.parse(readFileSync(join(directory, file), 'utf8')));
      return { ...fixture, file, stdoutText: stdoutText(fixture) };
    });
}

// The first word of every `gh` argument list this capsule builds.
const GH_COMMANDS = new Set([
  '--version',
  'api',
  'auth',
  'issue',
  'label',
  'pr',
  'release',
  'repo',
  'run',
  'search',
  'workflow',
]);
const PARSE_METHODS = new Set(['parse', 'safeParse', 'parseAsync', 'safeParseAsync']);
const PARSE_FUNCTIONS = new Set(['parseGhJson', 'parseProviderJson']);

/** The name of the function, method or named arrow function `node` is in. */
function enclosingFunction(node: ts.Node): string {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if ((ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name) {
      return parent.name.getText();
    }
    if (
      (ts.isVariableDeclaration(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isPropertyDeclaration(parent)) &&
      parent.initializer &&
      (ts.isArrowFunction(parent.initializer) || ts.isFunctionExpression(parent.initializer))
    ) {
      return parent.name.getText();
    }
  }
  return '<module>';
}

/** A schema named by an identifier chain keeps its name; any other expression is `<inline>`. */
function receiverName(node: ts.Expression): string {
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const object = receiverName(node.expression);
    return object === '<inline>' ? object : `${object}.${node.name.text}`;
  }
  return '<inline>';
}

/** The leading string literals of a `gh` argument list, up to three. */
function ghArgumentPrefix(node: ts.ArrayLiteralExpression): string | null {
  const prefix: string[] = [];
  for (const element of node.elements.slice(0, 3)) {
    if (!ts.isStringLiteral(element)) {
      break;
    }
    prefix.push(element.text);
  }
  return prefix[0] !== undefined && GH_COMMANDS.has(prefix[0]) ? prefix.join(' ') : null;
}

/** What a call parses with, when it is a parse: a parse function, or a parse method (not `Date.parse`). */
function parseName(node: ts.CallExpression): string | null {
  const callee = node.expression;
  if (ts.isIdentifier(callee) && PARSE_FUNCTIONS.has(callee.text)) {
    return callee.text;
  }
  if (!(ts.isPropertyAccessExpression(callee) && PARSE_METHODS.has(callee.name.text))) {
    return null;
  }
  const receiver = receiverName(callee.expression);
  return receiver === 'Date' ? null : `${receiver}.${callee.name.text}`;
}

/**
 * Every `gh` call (an argument list whose first element is a `gh` command) and
 * every parse (`parseGhJson`, `parseProviderJson`, `JSON.parse` and a Zod
 * `parse`/`safeParse` on any receiver) in this capsule's sources, read from
 * the syntax tree, so the way a call is written does not hide it. Keys are
 * `<file> <function>: <what>`, with ` #n` for the nth such site in a function.
 */
function capsuleSites(): { calls: string[]; parses: string[] } {
  const calls: string[] = [];
  const parses: string[] = [];
  const files = readdirSync(import.meta.dirname, { recursive: true, encoding: 'utf8' }).filter(
    (file) => file.endsWith('.ts') && !file.endsWith('.test.ts')
  );
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(join(import.meta.dirname, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const counts = new Map<string, number>();
    const add = (list: string[], node: ts.Node, what: string) => {
      const key = `${basename(file)} ${enclosingFunction(node)}: ${what}`;
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      list.push(n === 1 ? key : `${key} #${n}`);
    };
    const visit = (node: ts.Node) => {
      const prefix = ts.isArrayLiteralExpression(node) ? ghArgumentPrefix(node) : null;
      if (prefix) {
        add(calls, node, prefix);
      }
      const parse = ts.isCallExpression(node) ? parseName(node) : null;
      if (parse) {
        add(parses, node, parse);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { calls: calls.sort(), parses: parses.sort() };
}

const WRITES = 'not recorded: writes';
const INPUT = 'validates an input, not gh output';

/** Every `gh` call in the capsule: the recording of its output, or why there is none. */
const GH_CALLS: Record<string, string> = {
  'github-cli.service.ts runCheckHealth: --version': 'version.json',
  'github-cli.service.ts runCheckHealth: auth status': 'auth-status.json',
  'auth-check.ts checkGithubAuth: auth status': 'auth-status.json',
  'github-cli.service.ts getAuthenticatedUsername: api user --jq': 'api-user-login.json',
  'github-cli.service.ts getPRPreview: pr view': 'pr-view-preview.json',
  'pr-details.ts getPRStatusDetails: pr view': 'pr-view-status.json',
  'pr-details.ts getPRObservationDetails: pr view': 'pr-view-observation.json',
  'pr-details.ts getPRFullDetails: pr view': 'pr-view-full.json',
  'code-review.ts getPRDescription: pr view': 'pr-view-body.json',
  'code-review.ts getPRHeadCommitSha: pr view': 'pr-view-head-sha.json',
  'reviews.ts getChronologicalReviews: api': 'api-pr-reviews.json',
  'github-cli.service.ts getReviewComments: api': 'api-pr-review-comments.json',
  'github-cli.service.ts fetchReviewThreadsPage: api graphql -f': 'graphql-review-threads.json',
  'github-cli.service.ts fetchThreadCommentsPage: api graphql -f': 'graphql-thread-comments.json',
  'github-cli.service.ts listOpenPRs: api graphql -f': 'graphql-open-prs.json',
  'review-requests.ts listReviewRequests: api graphql -f': 'graphql-review-requests.json',
  'github-cli.service.ts getIssuePreview: issue view': 'issue-view-preview.json',
  'github-cli.service.ts getIssue: issue view': 'issue-view.json',
  'github-cli.service.ts fetchIssues: issue list --repo': 'issue-list.json',
  'issue-search.ts listMatchingIssues: issue list --repo': 'issue-list-search.json',
  'issue-search.ts lookupIssueNumber: api': 'api-issue.json',
  'agent-sources.ts getAgentRepository: api': 'api-repo.json',
  'agent-sources.ts getAgentRepository: api #2': 'api-repo-labels.json',
  'agent-issue-events.ts getAgentRepositoryIdentity: api': 'api-repo.json',
  'agent-issue-events.ts listAgentIssueEvents: api': 'api-issue-events.json',
  'pr-details.ts getPRDiff: pr diff':
    'not recorded: no schema reads it; the diff is passed on as text, and an allowlist of its lines keeps nothing',
  'github-cli.service.ts submitReview: pr review': WRITES,
  'github-cli.service.ts addPRComment: pr comment': WRITES,
  'github-cli.service.ts addIssueComment: issue comment': WRITES,
  'code-review.ts submitCodeReview: api --method POST': WRITES,
  'code-review.ts createReviewComment: api --method POST': WRITES,
};

/** Every parse in the capsule: the recording it parses, or why it reads no recording. */
const PARSE_SITES: Record<string, string> = {
  'github-cli.service.ts getPRPreview: parseGhJson': 'pr-view-preview.json',
  'pr-details.ts getPRStatusDetails: parseGhJson': 'pr-view-status.json',
  'pr-details.ts getPRObservationDetails: parseGhJson': 'pr-view-observation.json',
  'pr-observation.service.ts fetch: prObservationSchema.parse': 'pr-view-observation.json',
  'pr-details.ts getPRFullDetails: parseGhJson': 'pr-view-full.json',
  'reviews.ts getChronologicalReviews: parseGhJson': 'api-pr-reviews.json',
  'github-cli.service.ts getReviewComments: parseGhJson': 'api-pr-review-comments.json',
  'github-cli.service.ts fetchReviewThreadsPage: parseGhJson': 'graphql-review-threads.json',
  'github-cli.service.ts fetchThreadCommentsPage: parseGhJson': 'graphql-thread-comments.json',
  'github-cli.service.ts listOpenPRs: parseGhJson': 'graphql-open-prs.json',
  'review-requests.ts listReviewRequests: JSON.parse': 'graphql-review-requests.json',
  'review-requests.ts listReviewRequests: reviewRequestedPRGraphQLSchema.safeParse':
    'graphql-review-requests.json',
  'review-requests.ts listReviewRequests: githubPRPreviewInputSchema.shape.repo.safeParse': INPUT,
  'github-cli.service.ts getIssuePreview: parseGhJson': 'issue-view-preview.json',
  'github-cli.service.ts getIssue: parseGhJson': 'issue-view.json',
  'github-cli.service.ts fetchIssues: parseGhJson': 'issue-list.json',
  'issue-search.ts listMatchingIssues: parseGhJson': 'issue-list-search.json',
  'issue-search.ts lookupIssueNumber: parseGhJson': 'api-issue.json',
  'agent-sources.ts getAgentRepository: JSON.parse': 'api-repo.json',
  'agent-sources.ts getAgentRepository: repositorySchema.parse': 'api-repo.json',
  'agent-sources.ts getAgentRepository: JSON.parse #2': 'api-repo-labels.json',
  'agent-sources.ts getAgentRepository: labelsSchema.parse': 'api-repo-labels.json',
  'agent-sources.ts getAgentRepository: githubIssuePreviewInputSchema.shape.repo.safeParse': INPUT,
  'agent-issue-events.ts getAgentRepositoryIdentity: parseProviderJson': 'api-repo.json',
  'agent-issue-events.ts getAgentRepositoryIdentity: <inline>.parse': 'api-repo.json',
  'agent-issue-events.ts getAgentRepositoryIdentity: githubIssuePreviewInputSchema.shape.repo.parse':
    INPUT,
  'agent-issue-events.ts listAgentIssueEvents: parseProviderJson': 'api-issue-events.json',
  'agent-issue-events.ts listAgentIssueEvents: <inline>.parse #2': 'api-issue-events.json',
  'agent-issue-events.ts listAgentIssueEvents: controlSchema.parse': 'api-issue-events.json',
  'agent-issue-events.ts listAgentIssueEvents: executableSchema.parse': 'api-issue-events.json',
  'agent-issue-events.ts listAgentIssueEvents: agentIssueEventPageSchema.parse':
    'api-issue-events.json',
  'agent-issue-events.ts listAgentIssueEvents: <inline>.parse': `${INPUT} (z.literal(100), the page size)`,
  'agent-issue-events.ts listAgentIssueEvents: id.parse': INPUT,
  'agent-issue-events.ts listAgentIssueEvents: githubIssuePreviewInputSchema.shape.repo.parse':
    INPUT,
  'agent-issue-events.ts listAgentIssueEvents: agentSourcePageNumberSchema.parse': INPUT,
  'agent-issue-events.ts parseProviderJson: JSON.parse':
    'the reader inside parseProviderJson, whose calls are mapped above',
  'utils.ts parseGhJson: JSON.parse': 'the reader inside parseGhJson, whose calls are mapped above',
  'utils.ts parseGhJson: schema.parse':
    'the reader inside parseGhJson, whose calls are mapped above',
};

/** Variants of recorded calls with no recording of their own, and why. */
const NOT_RECORDED: Record<string, string> = {
  'listReviewRequests() with no repository: search `is:pr is:open review-requested:@me archived:false`':
    "reads the recording account's review requests across all repositories, which is account data",
  'gh issue list ... --assignee @me':
    "reads the recording account's assignments; output and schema are those of issue-list.json",
  'gh api repos/<repo>/pulls/<n>/comments?...&since=<time>&...':
    'the same output and schema as api-pr-review-comments.json, filtered by time',
  'later pages: open pull requests and review requests (`after: <cursor>`), review comments (`page=2` and on)':
    'the same output shape and schema as the recorded first page',
  'gh auth status --active (ff setup, src/cli/setup-prerequisites.mjs)':
    'reads only the exit code; auth-status.json is the same call',
};

/**
 * What the recordings do not exercise: schema branches no recorded value
 * reaches. The next recording should pick objects that widen this list's
 * coverage.
 */
const NOT_EXERCISED = [
  'reviewDecision APPROVED, CHANGES_REQUESTED or REVIEW_REQUIRED: only "" and null were recorded',
  'statusCheckRollup entries with __typename StatusContext (context, state, targetUrl)',
  'a check conclusion of null: running checks recorded ""',
  'a non-empty labels list on a pull request',
  'pull request or issue state CLOSED in a pr view or issue view read',
  'a null author, user or actor (a deleted account)',
  'review states other than COMMENTED',
  'a review thread with isResolved false',
  'the reopened issue event',
  'issue labels given as plain strings rather than objects',
  'gh timestamps as gh prints them: every recorded timestamp is the scrubber\'s whole-second "…Z" fake, so z.iso.datetime() is checked against that form only',
];

const versions = readdirSync(recordingsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
  .map((entry) => entry.name);

it('has a recording of gh output, and lists what it leaves out', () => {
  expect(versions.length).toBeGreaterThan(0);
  expect(Object.keys(NOT_RECORDED).length).toBeGreaterThan(0);
  expect(NOT_EXERCISED.length).toBeGreaterThan(0);
});

it('maps every gh call and every parse in the capsule to a recording or a reason', () => {
  const sites = capsuleSites();
  expect(sites.calls).toEqual(Object.keys(GH_CALLS).sort());
  expect(sites.parses).toEqual(Object.keys(PARSE_SITES).sort());
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
    const mapped = new Set(
      [...Object.values(GH_CALLS), ...Object.values(PARSE_SITES)].filter((value) =>
        value.endsWith('.json')
      )
    );
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
