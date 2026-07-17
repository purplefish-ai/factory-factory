import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pLimit from 'p-limit';
import { createLogger } from '@/backend/services/logger.service';
import { isRateLimitMessage } from '@/backend/services/rate-limit-backoff';
import type { CIStatus, PRState } from '@/shared/core';
import type { PRWithFullDetails, ReviewAction } from '@/shared/github-types';
import { GH_CONCURRENCY, GH_MAX_BUFFER_BYTES, GH_TIMEOUT_MS } from './github-cli/constants';
import { classifyError, logGitHubCLIError } from './github-cli/errors';
import {
  computeCIStatus,
  computePRState,
  mapComments,
  mapLabels,
  mapReviews,
  mapStatusChecks,
} from './github-cli/mappers';
import {
  fullPRDetailsSchema,
  issueSchema,
  openPullRequestsGraphQLSchema,
  prStatusSchema,
  type ResolvedReviewThreadsPage,
  type ReviewThreadCommentsConnection,
  resolvedReviewThreadsGraphQLSchema,
  reviewCommentSchema,
  reviewRequestedPRGraphQLSchema,
  reviewThreadCommentsGraphQLSchema,
} from './github-cli/schemas';
import type {
  GitHubCLIErrorType,
  GitHubCLIHealthStatus,
  GitHubIssue,
  OpenPullRequest,
  PRInfo,
  PRStatusFromGitHub,
  ReviewRequestedPR,
} from './github-cli/types';
import { parseGhJson } from './github-cli/utils';

const execFileAsync = promisify(execFile);
const logger = createLogger('github-cli');

type ExecResult = { stdout: string; stderr: string };
type ReadExecOptions = { timeout?: number; maxBuffer?: number; signal?: AbortSignal };

interface TruncatedResolvedThread {
  threadId: string;
  afterCursor: string | null;
}

/**
 * Collect comment ids from resolved threads into resolvedIds, returning
 * continuations for resolved threads whose comment list was truncated at the
 * first page (they need follow-up node queries to fetch the tail).
 */
function collectResolvedReviewCommentIds(
  threads: ResolvedReviewThreadsPage['nodes'],
  resolvedIds: Set<number>
): TruncatedResolvedThread[] {
  const truncatedThreads: TruncatedResolvedThread[] = [];
  for (const thread of threads) {
    if (!thread.isResolved) {
      continue;
    }
    for (const comment of thread.comments.nodes) {
      if (comment.fullDatabaseId !== null) {
        resolvedIds.add(comment.fullDatabaseId);
      }
    }
    if (thread.comments.pageInfo.hasNextPage) {
      truncatedThreads.push({
        threadId: thread.id,
        afterCursor: thread.comments.pageInfo.endCursor,
      });
    }
  }
  return truncatedThreads;
}

/**
 * Service for interacting with GitHub via the `gh` CLI.
 * Uses the locally authenticated gh CLI instead of API tokens.
 *
 * All process spawning is gated through a shared concurrency limiter
 * and read-only calls benefit from in-flight deduplication (singleflight).
 */
// How long to fast-fail gh calls after a rate limit is detected (60 s).
const RATE_LIMIT_FAST_FAIL_MS = 60_000;

class GitHubCLIService {
  private readonly execLimit = pLimit(GH_CONCURRENCY);
  private readonly inflight = new Map<string, Promise<ExecResult>>();

  // Stale-while-revalidate caches for expensive GitHub CLI calls.
  private cachedHealth: { result: GitHubCLIHealthStatus; fetchedAt: number } | null = null;
  private healthRefreshInFlight = false;
  private readonly HEALTH_CACHE_TTL_MS = 30_000;

  private readonly issueCache = new Map<string, { issues: GitHubIssue[]; fetchedAt: number }>();
  private readonly issueRefreshInFlight = new Set<string>();
  private readonly ISSUE_CACHE_TTL_MS = 60_000;

  // When set, all exec() calls will fail immediately until this timestamp.
  private rateLimitedUntil: number | null = null;

  /** Clear all caches — used in tests to prevent cross-test contamination. */
  clearCaches(): void {
    this.cachedHealth = null;
    this.healthRefreshInFlight = false;
    this.issueCache.clear();
    this.issueRefreshInFlight.clear();
    this.rateLimitedUntil = null;
  }

  /**
   * Execute a read-only gh CLI command with concurrency limiting and singleflight dedup.
   * Identical in-flight calls share a single process.
   *
   * Fast-fails immediately when a rate limit was detected recently, preventing
   * calls from piling up in the queue and blocking user-facing requests.
   */
  private exec(args: string[], options?: ReadExecOptions): Promise<ExecResult> {
    if (this.rateLimitedUntil !== null && Date.now() < this.rateLimitedUntil) {
      return Promise.reject(new Error('GitHub API rate limit exceeded, backing off'));
    }

    const execute = () =>
      this.execLimit(() => {
        options?.signal?.throwIfAborted();
        return execFileAsync('gh', args, {
          timeout: options?.timeout ?? GH_TIMEOUT_MS.default,
          ...(options?.maxBuffer ? { maxBuffer: options.maxBuffer } : {}),
          ...(options?.signal ? { signal: options.signal } : {}),
        });
      }).then(
        (result) => result,
        (err: unknown) => {
          const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
          if (isRateLimitMessage(msg)) {
            this.rateLimitedUntil = Date.now() + RATE_LIMIT_FAST_FAIL_MS;
          }
          throw err;
        }
      );

    if (options?.signal) {
      return execute();
    }

    const key = args.join('\0');
    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }

    const promise = execute().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  /**
   * Execute a mutating gh CLI command with concurrency limiting but NO dedup.
   * Used for write operations (approve, comment, close, etc.).
   *
   * Also applies rate-limit fast-fail to avoid queueing behind other blocked calls.
   */
  private execMutating(
    args: string[],
    options?: { timeout?: number; maxBuffer?: number }
  ): Promise<ExecResult> {
    if (this.rateLimitedUntil !== null && Date.now() < this.rateLimitedUntil) {
      return Promise.reject(new Error('GitHub API rate limit exceeded, backing off'));
    }

    return this.execLimit(() =>
      execFileAsync('gh', args, {
        timeout: options?.timeout ?? GH_TIMEOUT_MS.default,
        ...(options?.maxBuffer ? { maxBuffer: options.maxBuffer } : {}),
      })
    ).then(
      (result) => result,
      (err: unknown) => {
        const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
        if (isRateLimitMessage(msg)) {
          this.rateLimitedUntil = Date.now() + RATE_LIMIT_FAST_FAIL_MS;
        }
        throw err;
      }
    );
  }

  /**
   * Get the authenticated user's GitHub username.
   * Returns null if not authenticated or gh CLI is not available.
   */
  async getAuthenticatedUsername(signal?: AbortSignal): Promise<string | null> {
    try {
      const { stdout } = await this.exec(['api', 'user', '--jq', '.login'], {
        timeout: GH_TIMEOUT_MS.userLookup,
        signal,
      });
      return stdout.trim() || null;
    } catch {
      signal?.throwIfAborted();
      return null;
    }
  }

  /**
   * Check if gh CLI is installed and authenticated.
   * Result is cached for 30 s (stale-while-revalidate).
   */
  async checkHealth(): Promise<GitHubCLIHealthStatus> {
    const now = Date.now();
    if (this.cachedHealth) {
      const isStale = now - this.cachedHealth.fetchedAt >= this.HEALTH_CACHE_TTL_MS;
      if (isStale && !this.healthRefreshInFlight) {
        this.healthRefreshInFlight = true;
        this.runCheckHealth()
          .then((result) => {
            this.cachedHealth = { result, fetchedAt: Date.now() };
          })
          .catch(() => {
            // Keep stale value on error.
          })
          .finally(() => {
            this.healthRefreshInFlight = false;
          });
      }
      return this.cachedHealth.result;
    }
    // First call: no cache — fetch synchronously.
    const result = await this.runCheckHealth();
    this.cachedHealth = { result, fetchedAt: Date.now() };
    return result;
  }

  private async runCheckHealth(): Promise<GitHubCLIHealthStatus> {
    try {
      const { stdout: versionOutput } = await this.exec(['--version'], {
        timeout: GH_TIMEOUT_MS.healthVersion,
      });
      const versionMatch = versionOutput.match(/gh version ([\d.]+)/);
      const version = versionMatch?.[1];

      try {
        await this.exec(['auth', 'status'], { timeout: GH_TIMEOUT_MS.healthAuth });
        return { isInstalled: true, isAuthenticated: true, version };
      } catch {
        return {
          isInstalled: true,
          isAuthenticated: false,
          version,
          error: 'GitHub CLI is not authenticated. Run `gh auth login` to authenticate.',
          errorType: 'auth_required',
        };
      }
    } catch (error) {
      const errorType = classifyError(error);
      return {
        isInstalled: false,
        isAuthenticated: false,
        error:
          errorType === 'cli_not_installed'
            ? 'GitHub CLI (gh) is not installed. Install from https://cli.github.com/'
            : `Failed to check gh CLI: ${error instanceof Error ? error.message : String(error)}`,
        errorType,
      };
    }
  }

  /**
   * Extract PR info (owner, repo, number) from a GitHub PR URL.
   */
  extractPRInfo(prUrl: string): PRInfo | null {
    const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) {
      return null;
    }

    return {
      owner: match[1] as string,
      repo: match[2] as string,
      number: Number.parseInt(match[3] as string, 10),
    };
  }

  /**
   * Get PR status from GitHub using the gh CLI.
   */
  async getPRStatus(prUrl: string): Promise<PRStatusFromGitHub | null> {
    const prInfo = this.extractPRInfo(prUrl);
    if (!prInfo) {
      logger.warn('Could not parse PR URL', { prUrl });
      return null;
    }

    try {
      const { stdout } = await this.exec(
        [
          'pr',
          'view',
          String(prInfo.number),
          '--repo',
          `${prInfo.owner}/${prInfo.repo}`,
          '--json',
          'number,state,isDraft,reviewDecision,statusCheckRollup,headRefName',
        ],
        { timeout: GH_TIMEOUT_MS.default }
      );

      return parseGhJson(prStatusSchema, stdout, 'getPRStatus');
    } catch (error) {
      const errorType = classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logGitHubCLIError(errorType, errorMessage, { prUrl });
      if (errorType === 'rate_limit') {
        throw error;
      }
      return null;
    }
  }

  computeCIStatus(statusCheckRollup: PRStatusFromGitHub['statusCheckRollup']) {
    return computeCIStatus(statusCheckRollup);
  }

  computePRState(status: PRStatusFromGitHub) {
    return computePRState(status);
  }

  /**
   * Fetch PR status and convert to our PRState.
   * Returns null if PR cannot be fetched.
   */
  async fetchAndComputePRState(prUrl: string): Promise<{
    prState: PRState;
    prNumber: number;
    prReviewState: string | null;
    prCiStatus: CIStatus;
    headRefName: string | null;
  } | null> {
    const status = await this.getPRStatus(prUrl);
    if (!status) {
      return null;
    }

    return {
      prState: this.computePRState(status),
      prNumber: status.number,
      prReviewState: status.reviewDecision,
      prCiStatus: this.computeCIStatus(status.statusCheckRollup),
      headRefName: status.headRefName ?? null,
    };
  }

  /**
   * List all PRs where the authenticated user is requested as a reviewer.
   * Uses paginated GraphQL search calls to fetch all matching PRs.
   */
  async listReviewRequests(): Promise<ReviewRequestedPR[]> {
    const MAX_PAGES = 20;
    const prs: ReviewRequestedPR[] = [];
    let afterCursor: string | null = null;
    let hasNextPage = true;

    for (let page = 1; page <= MAX_PAGES && hasNextPage; page++) {
      const afterClause = afterCursor ? `, after: ${JSON.stringify(afterCursor)}` : '';
      const query = `
        query {
          search(query: "is:pr is:open review-requested:@me", type: ISSUE, first: 50${afterClause}) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              ... on PullRequest {
                number title url isDraft createdAt
                author { login }
                repository { nameWithOwner }
                reviewDecision
                additions deletions changedFiles
              }
            }
          }
        }
      `;

      const { stdout } = await this.exec(['api', 'graphql', '-f', `query=${query}`], {
        timeout: GH_TIMEOUT_MS.default,
      });

      const parsed = reviewRequestedPRGraphQLSchema.safeParse(JSON.parse(stdout));
      if (!parsed.success) {
        logger.warn('Failed to parse listReviewRequests GraphQL response', {
          error: parsed.error.message,
        });
        return prs;
      }

      prs.push(
        ...parsed.data.data.search.nodes.map((pr) => ({
          number: pr.number,
          title: pr.title,
          url: pr.url,
          repository: { nameWithOwner: pr.repository.nameWithOwner },
          author: { login: pr.author?.login ?? '' },
          createdAt: pr.createdAt,
          isDraft: pr.isDraft,
          reviewDecision: (pr.reviewDecision as ReviewRequestedPR['reviewDecision']) ?? null,
          additions: pr.additions ?? 0,
          deletions: pr.deletions ?? 0,
          changedFiles: pr.changedFiles ?? 0,
        }))
      );

      hasNextPage = parsed.data.data.search.pageInfo.hasNextPage;
      afterCursor = parsed.data.data.search.pageInfo.endCursor;
      if (hasNextPage && !afterCursor) {
        logger.warn('GitHub review request page is missing an end cursor');
        return prs;
      }

      if (page === MAX_PAGES && hasNextPage) {
        logger.warn('listReviewRequests: reached MAX_PAGES limit, results may be incomplete', {
          totalFetched: prs.length,
          maxPages: MAX_PAGES,
        });
      }
    }

    return prs;
  }

  /** List every open pull request in a repository for local branch matching. */
  async listOpenPRs(owner: string, repo: string): Promise<OpenPullRequest[]> {
    const prs: OpenPullRequest[] = [];
    const seenCursors = new Set<string>();
    let afterCursor: string | null = null;

    while (true) {
      const afterClause = afterCursor ? `, after: ${JSON.stringify(afterCursor)}` : '';
      const query = `
        query {
          repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {
            pullRequests(
              states: OPEN
              first: 100${afterClause}
              orderBy: { field: CREATED_AT, direction: DESC }
            ) {
              pageInfo { hasNextPage endCursor }
              nodes { number url createdAt headRefName }
            }
          }
        }
      `;

      const { stdout } = await this.exec(['api', 'graphql', '-f', `query=${query}`], {
        timeout: GH_TIMEOUT_MS.default,
      });
      const parsed = parseGhJson(openPullRequestsGraphQLSchema, stdout, 'listOpenPRs');
      const connection = parsed.data.repository?.pullRequests;
      if (!connection) {
        throw new Error(`GitHub repository not found: ${owner}/${repo}`);
      }

      prs.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage) {
        return prs;
      }

      const nextCursor = connection.pageInfo.endCursor;
      if (!nextCursor) {
        throw new Error('GitHub open PR page is missing an end cursor');
      }
      if (seenCursors.has(nextCursor)) {
        throw new Error('GitHub open PR pagination repeated a cursor');
      }
      seenCursors.add(nextCursor);
      afterCursor = nextCursor;
    }
  }

  /**
   * Approve a PR.
   */
  async approvePR(owner: string, repo: string, prNumber: number): Promise<void> {
    const args = ['pr', 'review', String(prNumber), '--repo', `${owner}/${repo}`, '--approve'];

    try {
      await this.execMutating(args, { timeout: GH_TIMEOUT_MS.default });
      logger.info('PR approved successfully', { owner, repo, prNumber });
    } catch (error) {
      const errorType = classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to approve PR via gh CLI', {
        owner,
        repo,
        prNumber,
        errorType,
        error: errorMessage,
      });

      throw new Error(`Failed to approve PR: ${errorMessage}`);
    }
  }

  /**
   * Get full PR details including reviews, comments, labels, and CI status.
   */
  async getPRFullDetails(
    repo: string,
    prNumber: number,
    signal?: AbortSignal
  ): Promise<PRWithFullDetails> {
    const fields = [
      'number',
      'title',
      'url',
      'author',
      'createdAt',
      'updatedAt',
      'isDraft',
      'state',
      'reviewDecision',
      'statusCheckRollup',
      'reviews',
      'comments',
      'labels',
      'additions',
      'deletions',
      'changedFiles',
      'headRefName',
      'baseRefName',
      'mergeStateStatus',
    ].join(',');

    try {
      const { stdout } = await this.exec(
        ['pr', 'view', String(prNumber), '--repo', repo, '--json', fields],
        { timeout: GH_TIMEOUT_MS.default, signal }
      );

      const data = parseGhJson(fullPRDetailsSchema, stdout, 'getPRFullDetails');

      const [, repoName] = repo.split('/') as [string, string];

      return {
        number: data.number,
        title: data.title,
        url: data.url,
        author: data.author,
        repository: {
          name: repoName,
          nameWithOwner: repo,
        },
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        isDraft: data.isDraft,
        state: data.state,
        reviewDecision: data.reviewDecision,
        statusCheckRollup: data.statusCheckRollup ? mapStatusChecks(data.statusCheckRollup) : null,
        reviews: mapReviews(data.reviews),
        comments: mapComments(data.comments),
        labels: mapLabels(data.labels),
        additions: data.additions || 0,
        deletions: data.deletions || 0,
        changedFiles: data.changedFiles || 0,
        headRefName: data.headRefName || '',
        baseRefName: data.baseRefName || '',
        mergeStateStatus: data.mergeStateStatus || 'UNKNOWN',
      };
    } catch (error) {
      signal?.throwIfAborted();
      const errorType = classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to fetch PR details via gh CLI', {
        repo,
        prNumber,
        errorType,
        error: errorMessage,
      });

      throw new Error(`Failed to fetch PR details: ${errorMessage}`);
    }
  }

  /**
   * Get the diff for a PR.
   */
  async getPRDiff(repo: string, prNumber: number): Promise<string> {
    try {
      const { stdout } = await this.exec(['pr', 'diff', String(prNumber), '--repo', repo], {
        timeout: GH_TIMEOUT_MS.diff,
        maxBuffer: GH_MAX_BUFFER_BYTES.diff,
      });

      return stdout;
    } catch (error) {
      const errorType = classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to fetch PR diff via gh CLI', {
        repo,
        prNumber,
        errorType,
        error: errorMessage,
      });

      throw new Error(`Failed to fetch PR diff: ${errorMessage}`);
    }
  }

  /**
   * Submit a review for a PR (approve, request changes, or comment).
   */
  async submitReview(
    repo: string,
    prNumber: number,
    action: ReviewAction,
    body?: string
  ): Promise<void> {
    const actionFlags: Record<ReviewAction, string> = {
      approve: '--approve',
      'request-changes': '--request-changes',
      comment: '--comment',
    };

    const args = ['pr', 'review', String(prNumber), '--repo', repo, actionFlags[action]];

    if (body && (action === 'request-changes' || action === 'comment')) {
      args.push('--body', body);
    }

    try {
      await this.execMutating(args, { timeout: GH_TIMEOUT_MS.default });
      logger.info('PR review submitted successfully', { repo, prNumber, action });
    } catch (error) {
      const errorType = classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to submit PR review via gh CLI', {
        repo,
        prNumber,
        action,
        errorType,
        error: errorMessage,
      });

      throw new Error(`Failed to submit review: ${errorMessage}`);
    }
  }

  /**
   * List open issues for a repository.
   * Results are cached for 60 s (stale-while-revalidate).
   * @param assignee - Filter by assignee. Use '@me' for issues assigned to the authenticated user.
   */
  async listIssues(
    owner: string,
    repo: string,
    options: { limit?: number; assignee?: string } = {}
  ): Promise<GitHubIssue[]> {
    const { limit = 50, assignee } = options;
    const cacheKey = `${owner}/${repo}?limit=${limit}&assignee=${assignee ?? ''}`;
    const now = Date.now();
    const cached = this.issueCache.get(cacheKey);

    if (cached) {
      const isStale = now - cached.fetchedAt >= this.ISSUE_CACHE_TTL_MS;
      if (isStale && !this.issueRefreshInFlight.has(cacheKey)) {
        this.issueRefreshInFlight.add(cacheKey);
        this.fetchIssues(owner, repo, options)
          .then((issues) => {
            this.issueCache.set(cacheKey, { issues, fetchedAt: Date.now() });
          })
          .catch(() => {
            // Keep stale value on error.
          })
          .finally(() => {
            this.issueRefreshInFlight.delete(cacheKey);
          });
      }
      return cached.issues;
    }

    // First call: no cache — fetch synchronously and populate cache.
    const issues = await this.fetchIssues(owner, repo, options);
    this.issueCache.set(cacheKey, { issues, fetchedAt: Date.now() });
    return issues;
  }

  private async fetchIssues(
    owner: string,
    repo: string,
    options: { limit?: number; assignee?: string } = {}
  ): Promise<GitHubIssue[]> {
    const { limit = 50, assignee } = options;
    try {
      const args = [
        'issue',
        'list',
        '--repo',
        `${owner}/${repo}`,
        '--state',
        'open',
        '--json',
        'number,title,body,url,state,createdAt,author',
        '--limit',
        String(limit),
      ];

      if (assignee) {
        args.push('--assignee', assignee);
      }

      const { stdout } = await this.exec(args, { timeout: GH_TIMEOUT_MS.default });

      return parseGhJson(issueSchema.array(), stdout, 'listIssues');
    } catch (error) {
      const errorType = classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to list issues via gh CLI', {
        owner,
        repo,
        errorType,
        error: errorMessage,
      });

      throw new Error(`Failed to list issues: ${errorMessage}`);
    }
  }

  /**
   * Get review comments (line-level comments on code) for a PR.
   * These are different from regular PR comments - they're attached to specific lines in the diff.
   */
  async getReviewComments(
    repo: string,
    prNumber: number,
    since?: Date,
    signal?: AbortSignal
  ): Promise<
    Array<{
      id: number;
      author: { login: string };
      body: string;
      path: string;
      line: number | null;
      createdAt: string;
      updatedAt: string;
      url: string;
    }>
  > {
    try {
      // Paginate through all pages (100 per page) to avoid silently dropping comments beyond
      // the first page. The `since` filter bounds incremental fetches; pagination ensures
      // correctness for large PRs. Cap at MAX_PAGES to prevent unbounded API usage.
      const PAGE_SIZE = 100;
      const MAX_PAGES = 20;
      const allComments: Array<{
        id: number;
        author: { login: string };
        body: string;
        path: string;
        line: number | null;
        createdAt: string;
        updatedAt: string;
        url: string;
      }> = [];

      for (let page = 1; page <= MAX_PAGES; page++) {
        signal?.throwIfAborted();
        const sinceParam = since ? `&since=${since.toISOString()}` : '';
        const path = `repos/${repo}/pulls/${prNumber}/comments?per_page=${PAGE_SIZE}&page=${page}${sinceParam}`;

        const { stdout } = await this.exec(['api', path], {
          timeout: GH_TIMEOUT_MS.default,
          maxBuffer: GH_MAX_BUFFER_BYTES.reviewComments,
          signal,
        });
        signal?.throwIfAborted();

        if (!stdout.trim()) {
          break;
        }

        const pageComments = parseGhJson(reviewCommentSchema.array(), stdout, 'getReviewComments');
        for (const comment of pageComments) {
          allComments.push({
            id: comment.id,
            author: { login: comment.user.login },
            body: comment.body,
            path: comment.path,
            line: comment.line,
            createdAt: comment.created_at,
            updatedAt: comment.updated_at,
            url: comment.html_url,
          });
        }

        if (pageComments.length < PAGE_SIZE) {
          break;
        }

        if (page === MAX_PAGES) {
          logger.warn('getReviewComments: reached MAX_PAGES limit, results may be incomplete', {
            repo,
            prNumber,
            totalFetched: allComments.length,
            maxPages: MAX_PAGES,
          });
        }
      }

      return allComments;
    } catch (error) {
      signal?.throwIfAborted();
      const errorType = classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to fetch PR review comments via gh CLI', {
        repo,
        prNumber,
        errorType,
        error: errorMessage,
      });

      throw new Error(`Failed to fetch PR review comments: ${errorMessage}`);
    }
  }

  /**
   * Get the REST ids of review comments that belong to resolved review threads.
   * Thread resolution state is only exposed via GraphQL, while getReviewComments
   * uses the REST API — this returns the id set needed to join the two.
   */
  async getResolvedReviewCommentIds(
    repo: string,
    prNumber: number,
    signal?: AbortSignal
  ): Promise<Set<number>> {
    const [owner, name] = repo.split('/');
    if (!(owner && name)) {
      throw new Error(`Invalid repo format for getResolvedReviewCommentIds: ${repo}`);
    }

    try {
      signal?.throwIfAborted();
      const resolvedIds = new Set<number>();
      await this.collectResolvedIdsFromThreadPages(
        { owner, name, repo, prNumber },
        resolvedIds,
        signal
      );
      signal?.throwIfAborted();
      return resolvedIds;
    } catch (error) {
      signal?.throwIfAborted();
      const errorType = classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to fetch resolved review threads via gh CLI', {
        repo,
        prNumber,
        errorType,
        error: errorMessage,
      });

      throw new Error(`Failed to fetch resolved review threads: ${errorMessage}`);
    }
  }

  private async collectResolvedIdsFromThreadPages(
    ctx: { owner: string; name: string; repo: string; prNumber: number },
    resolvedIds: Set<number>,
    signal?: AbortSignal
  ): Promise<void> {
    const MAX_PAGES = 20;
    const logContext = { repo: ctx.repo, prNumber: ctx.prNumber };
    let afterCursor: string | null = null;

    for (let page = 1; page <= MAX_PAGES; page++) {
      signal?.throwIfAborted();
      const reviewThreads = await this.fetchReviewThreadsPage(
        ctx.owner,
        ctx.name,
        ctx.prNumber,
        afterCursor,
        signal
      );
      if (!reviewThreads) {
        logger.warn('getResolvedReviewCommentIds: repository or PR not found', logContext);
        return;
      }

      const truncatedThreads = collectResolvedReviewCommentIds(reviewThreads.nodes, resolvedIds);
      for (const thread of truncatedThreads) {
        await this.collectResolvedThreadCommentTail(thread, resolvedIds, logContext, signal);
      }

      if (!reviewThreads.pageInfo.hasNextPage) {
        return;
      }
      afterCursor = reviewThreads.pageInfo.endCursor;
      if (!afterCursor) {
        logger.warn(
          'getResolvedReviewCommentIds: review thread page is missing an end cursor',
          logContext
        );
        return;
      }
    }

    logger.warn('getResolvedReviewCommentIds: reached MAX_PAGES limit, results may be incomplete', {
      ...logContext,
      totalResolved: resolvedIds.size,
      maxPages: MAX_PAGES,
    });
  }

  private async fetchReviewThreadsPage(
    owner: string,
    name: string,
    prNumber: number,
    afterCursor: string | null,
    signal?: AbortSignal
  ): Promise<ResolvedReviewThreadsPage | null> {
    const afterClause = afterCursor ? `, after: ${JSON.stringify(afterCursor)}` : '';
    const query = `
      query {
        repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
          pullRequest(number: ${prNumber}) {
            reviewThreads(first: 100${afterClause}) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                isResolved
                comments(first: 100) {
                  pageInfo { hasNextPage endCursor }
                  nodes { fullDatabaseId }
                }
              }
            }
          }
        }
      }
    `;

    const { stdout } = await this.exec(['api', 'graphql', '-f', `query=${query}`], {
      timeout: GH_TIMEOUT_MS.default,
      maxBuffer: GH_MAX_BUFFER_BYTES.reviewComments,
      signal,
    });
    signal?.throwIfAborted();

    const parsed = parseGhJson(
      resolvedReviewThreadsGraphQLSchema,
      stdout,
      'getResolvedReviewCommentIds'
    );
    return parsed.data.repository?.pullRequest?.reviewThreads ?? null;
  }

  /**
   * Fetch the remaining comment pages of a resolved thread whose comment list
   * was truncated at the first page, adding their ids to resolvedIds.
   */
  private async collectResolvedThreadCommentTail(
    thread: TruncatedResolvedThread,
    resolvedIds: Set<number>,
    logContext: { repo: string; prNumber: number },
    signal?: AbortSignal
  ): Promise<void> {
    const MAX_PAGES = 20;
    let afterCursor = thread.afterCursor;

    for (let page = 1; page <= MAX_PAGES; page++) {
      signal?.throwIfAborted();
      if (!afterCursor) {
        logger.warn(
          'getResolvedReviewCommentIds: truncated thread comments are missing an end cursor',
          logContext
        );
        return;
      }

      const comments = await this.fetchThreadCommentsPage(thread.threadId, afterCursor, signal);
      if (!comments) {
        logger.warn('getResolvedReviewCommentIds: review thread not found while paging comments', {
          ...logContext,
          threadId: thread.threadId,
        });
        return;
      }

      for (const comment of comments.nodes) {
        if (comment.fullDatabaseId !== null) {
          resolvedIds.add(comment.fullDatabaseId);
        }
      }

      if (!comments.pageInfo.hasNextPage) {
        return;
      }
      afterCursor = comments.pageInfo.endCursor;
    }

    logger.warn(
      'getResolvedReviewCommentIds: reached MAX_PAGES limit while paging thread comments',
      { ...logContext, threadId: thread.threadId, maxPages: MAX_PAGES }
    );
  }

  private async fetchThreadCommentsPage(
    threadId: string,
    afterCursor: string,
    signal?: AbortSignal
  ): Promise<ReviewThreadCommentsConnection | null> {
    const query = `
      query {
        node(id: ${JSON.stringify(threadId)}) {
          ... on PullRequestReviewThread {
            comments(first: 100, after: ${JSON.stringify(afterCursor)}) {
              pageInfo { hasNextPage endCursor }
              nodes { fullDatabaseId }
            }
          }
        }
      }
    `;

    const { stdout } = await this.exec(['api', 'graphql', '-f', `query=${query}`], {
      timeout: GH_TIMEOUT_MS.default,
      maxBuffer: GH_MAX_BUFFER_BYTES.reviewComments,
      signal,
    });
    signal?.throwIfAborted();

    const parsed = parseGhJson(
      reviewThreadCommentsGraphQLSchema,
      stdout,
      'fetchThreadCommentsPage'
    );
    return parsed.data.node?.comments ?? null;
  }

  /**
   * Add a comment to a PR.
   */
  async addPRComment(repo: string, prNumber: number, body: string): Promise<void> {
    try {
      await this.execMutating(['pr', 'comment', String(prNumber), '--repo', repo, '--body', body], {
        timeout: GH_TIMEOUT_MS.default,
      });
      logger.info('PR comment added successfully', { repo, prNumber });
    } catch (error) {
      const errorType = classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to add PR comment via gh CLI', {
        repo,
        prNumber,
        errorType,
        error: errorMessage,
      });

      throw new Error(`Failed to add PR comment: ${errorMessage}`);
    }
  }

  /**
   * Add a comment to a GitHub issue.
   */
  async addIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<void> {
    try {
      await this.execMutating(
        ['issue', 'comment', String(issueNumber), '--repo', `${owner}/${repo}`, '--body', body],
        { timeout: GH_TIMEOUT_MS.default }
      );
      logger.info('Issue comment added successfully', { owner, repo, issueNumber });
    } catch (error) {
      const errorType = classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to add issue comment via gh CLI', {
        owner,
        repo,
        issueNumber,
        errorType,
        error: errorMessage,
      });

      throw new Error(`Failed to add issue comment: ${errorMessage}`);
    }
  }

  /**
   * Get a single GitHub issue by number.
   */
  async getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubIssue | null> {
    try {
      const { stdout } = await this.exec(
        [
          'issue',
          'view',
          String(issueNumber),
          '--repo',
          `${owner}/${repo}`,
          '--json',
          'number,title,body,url,state,createdAt,author',
        ],
        { timeout: GH_TIMEOUT_MS.default }
      );

      return parseGhJson(issueSchema, stdout, 'getIssue');
    } catch (error) {
      const errorType = classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to get issue via gh CLI', {
        owner,
        repo,
        issueNumber,
        errorType,
        error: errorMessage,
      });

      return null;
    }
  }

  /**
   * Close a GitHub issue.
   */
  async closeIssue(owner: string, repo: string, issueNumber: number): Promise<void> {
    try {
      await this.execMutating(
        ['issue', 'close', String(issueNumber), '--repo', `${owner}/${repo}`],
        { timeout: GH_TIMEOUT_MS.default }
      );
      logger.info('Issue closed successfully', { owner, repo, issueNumber });
    } catch (error) {
      const errorType = classifyError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to close issue via gh CLI', {
        owner,
        repo,
        issueNumber,
        errorType,
        error: errorMessage,
      });

      throw new Error(`Failed to close issue: ${errorMessage}`);
    }
  }
}

export type {
  GitHubCLIErrorType,
  GitHubCLIHealthStatus,
  GitHubIssue,
  OpenPullRequest,
  PRInfo,
  PRStatusFromGitHub,
  ReviewRequestedPR,
};

export const githubCLIService = new GitHubCLIService();
