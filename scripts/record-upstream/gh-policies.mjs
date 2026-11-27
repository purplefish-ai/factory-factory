// The read-only `gh` calls Factory Factory makes, as the recorder runs them,
// and what may survive of each output (see ./gh-scrub.mjs).
//
// `args` builds the exact arguments the application passes, from the objects
// being recorded. The recorder calls it twice: with the real repository and
// ids to run `gh`, and with their fakes to write the fixture, so a fixture
// never names the real repository. The parse test in
// src/backend/services/github/service/gh-recordings.test.ts drives the
// production code against the fixtures and fails when the arguments it builds
// differ from the recorded ones (whitespace inside a GraphQL query aside).
//
// `fields` is the allowlist for JSON output: a key path (keys joined by `.`,
// array levels skipped) and the treatment of its value. A key whose path is
// neither listed nor the parent of a listed path is dropped. Treatments are
// described in ./gh-scrub.mjs.

/** The public objects of this repository the recording reads. Change them when re-recording. */
export const GH_OBJECTS = {
  repository: 'purplefish-ai/factory-factory',
  // Merged, with checks, reviews, a conversation comment and inline review comments.
  mergedPullRequest: 3349,
  // An open pull request of the architecture consolidation program.
  openPullRequest: 3365,
  issue: 3340,
  // Text for the issue search; any word that matches a few open issues.
  issueSearch: 'agent',
  // A page of repository issue events holding labels added to issues (#2934 to
  // #2941 on 2026-11-04), which event automations act on; page 1 had none.
  // Pages shift as events are added, so check it before re-recording.
  issueEventsPage: 18,
};

/** What the fixtures say instead of the real repository. */
export const FAKE_REPOSITORY = { owner: 'example-owner', name: 'example-repo' };

const PR_STATUS_FIELDS =
  'number,title,url,updatedAt,isDraft,state,reviewDecision,statusCheckRollup,headRefOid,headRefName,baseRefName,mergeStateStatus';
const PR_FULL_FIELDS =
  'number,title,url,author,createdAt,updatedAt,isDraft,state,reviewDecision,statusCheckRollup,comments,labels,additions,deletions,changedFiles,headRefName,headRefOid,baseRefName,mergeStateStatus';

// Copied from the application; the parse test compares them with what it sends.
const openPullRequestsQuery = ({ owner, name }) => `
        query {
          repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
            pullRequests(
              states: OPEN
              first: 100
              orderBy: { field: CREATED_AT, direction: DESC }
            ) {
              pageInfo { hasNextPage endCursor }
              nodes { number url createdAt headRefName }
            }
          }
        }
      `;

const reviewThreadsQuery = ({ owner, name }, prNumber) => `
      query {
        repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
          pullRequest(number: ${prNumber}) {
            reviewThreads(first: 100) {
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

const threadCommentsQuery = (threadId, afterCursor) => `
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

// The application searches `review-requested:@me`, which would read which pull
// requests ask the recording account for a review. The recording drops that
// qualifier: the query, the response shape and the schema are the same.
const reviewRequestsQuery = (repo) => `
        query {
          search(query: ${JSON.stringify(`is:pr is:open archived:false repo:${repo}`)}, type: ISSUE, first: 50) {
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

const CHECK_FIELDS = {
  'statusCheckRollup.__typename': 'keep',
  'statusCheckRollup.name': 'keep',
  'statusCheckRollup.status': 'keep',
  'statusCheckRollup.conclusion': 'keep',
  'statusCheckRollup.detailsUrl': 'url',
  'statusCheckRollup.workflowName': 'keep',
  'statusCheckRollup.startedAt': 'time',
  'statusCheckRollup.completedAt': 'time',
  'statusCheckRollup.context': 'keep',
  'statusCheckRollup.state': 'keep',
  'statusCheckRollup.targetUrl': 'url',
};

const PR_STATUS = {
  number: 'number',
  title: 'text',
  url: 'url',
  updatedAt: 'time',
  isDraft: 'keep',
  state: 'keep',
  reviewDecision: 'keep',
  ...CHECK_FIELDS,
  headRefOid: 'sha',
  headRefName: 'branch',
  baseRefName: 'branch',
  mergeStateStatus: 'keep',
};

const PR_COMMENTS = {
  'comments.id': 'id',
  'comments.author.login': 'login',
  'comments.authorAssociation': 'keep',
  'comments.body': 'text',
  'comments.createdAt': 'time',
  'comments.updatedAt': 'time',
  'comments.url': 'url',
  'comments.includesCreatedEdit': 'keep',
  'comments.isMinimized': 'keep',
  'comments.minimizedReason': 'keep',
};

const AUTHOR = { 'author.login': 'login', 'author.is_bot': 'keep' };

const under = (prefix, fields) =>
  Object.fromEntries(
    Object.entries(fields).map(([path, treatment]) => [
      prefix ? `${prefix}.${path}` : path,
      treatment,
    ])
  );

const REST_USER = (prefix) => under(prefix, { login: 'login', type: 'keep' });

const REST_LABEL = (prefix) =>
  under(prefix, { id: 'id', name: 'keep', color: 'keep', default: 'keep', description: 'text' });

const PAGE_INFO = (prefix) =>
  under(`${prefix}.pageInfo`, { hasNextPage: 'keep', endCursor: 'cursor' });

const ISSUE_EVENT_ISSUE = {
  'issue.id': 'id',
  'issue.number': 'number',
  'issue.title': 'text',
  'issue.body': 'text',
  'issue.html_url': 'url',
  'issue.state': 'keep',
  'issue.user.id': 'id',
  ...REST_USER('issue.user'),
  ...REST_LABEL('issue.labels'),
  'issue.pull_request': 'present',
};

/**
 * Executable issue events (a label added to, or the reopening of, an issue
 * that is not a pull request) are what event automations act on. The trimmed
 * page keeps two of them, then one row of each other event type, up to
 * `limit` rows, in page order.
 */
function issueEventsSelection(rows, limit) {
  const executable = (row) =>
    (row.event === 'labeled' || row.event === 'reopened') &&
    row.issue &&
    row.issue.pull_request === undefined;
  const keep = new Set(rows.filter(executable).slice(0, 2));
  for (const row of rows) {
    if (keep.size >= limit) {
      break;
    }
    if (![...keep].some((kept) => kept.event === row.event)) {
      keep.add(row);
    }
  }
  return rows.filter((row) => keep.has(row));
}

/** One check of each kind (type, workflow, state, host), so the trimmed list keeps its variety. */
function distinctChecks(rows, limit) {
  const seen = new Set();
  return rows
    .filter((row) => {
      let host = '';
      try {
        host = new URL(row.detailsUrl ?? row.targetUrl ?? '').hostname;
      } catch {
        // A check without a URL is its own kind.
      }
      const kind = [
        row.__typename,
        row.workflowName ?? '',
        row.status ?? row.state,
        row.conclusion ?? '',
        host,
      ].join('|');
      if (seen.has(kind)) {
        return false;
      }
      seen.add(kind);
      return true;
    })
    .slice(0, limit);
}

/**
 * Review comments with the lowest database ids, so the trimmed REST comments
 * and the trimmed review threads (by their first comment) are the same ones
 * and the resolved-comment join still finds them.
 */
function lowestIds(idOf) {
  return (rows, limit) => {
    const ids = new Set(
      rows
        .map((row) => Number(idOf(row)))
        .sort((a, b) => a - b)
        .slice(0, limit)
    );
    return rows.filter((row) => ids.has(Number(idOf(row))));
  };
}

const CHECKS_TRIM = { path: 'statusCheckRollup', limit: 8, select: distinctChecks };

/**
 * Every read-only call shape, in the order the recorder runs them. `values`
 * holds `repo` (`owner/name`), `owner`, `name`, the object numbers and, for
 * the thread-comments page, `threadId` and `threadCursor` read from the
 * review-thread recording.
 */
export const GH_SHAPES = [
  {
    file: 'version.json',
    description: '`gh --version`; the health check reads the version with a regular expression.',
    args: () => ['--version'],
    output: 'text',
    text: 'version',
  },
  {
    file: 'auth-status.json',
    description:
      '`gh auth status`; the health check reads its exit code, and the New Project badge reads the login from its "Logged in" line.',
    args: () => ['auth', 'status'],
    output: 'text',
    text: 'authStatus',
    allowFailure: true,
  },
  {
    file: 'api-user-login.json',
    description: '`gh api user --jq .login`: the authenticated login.',
    args: () => ['api', 'user', '--jq', '.login'],
    output: 'text',
    text: 'login',
  },
  {
    file: 'pr-view-preview.json',
    description: 'Pull request link preview (open pull request).',
    args: (v) => [
      'pr',
      'view',
      String(v.openPullRequest),
      '--repo',
      v.repo,
      '--json',
      'title,state,isDraft,author,createdAt,additions,deletions,changedFiles',
    ],
    output: 'json',
    fields: {
      title: 'text',
      state: 'keep',
      isDraft: 'keep',
      ...AUTHOR,
      createdAt: 'time',
      additions: 'number',
      deletions: 'number',
      changedFiles: 'number',
    },
  },
  {
    file: 'pr-view-status.json',
    description: 'Core monitoring facts (open pull request).',
    args: (v) => [
      'pr',
      'view',
      String(v.openPullRequest),
      '--repo',
      v.repo,
      '--json',
      PR_STATUS_FIELDS,
    ],
    output: 'json',
    trim: CHECKS_TRIM,
    fields: PR_STATUS,
  },
  {
    file: 'pr-view-observation.json',
    description: 'Core facts plus conversation comments (merged pull request).',
    args: (v) => [
      'pr',
      'view',
      String(v.mergedPullRequest),
      '--repo',
      v.repo,
      '--json',
      `${PR_STATUS_FIELDS},comments`,
    ],
    output: 'json',
    trim: CHECKS_TRIM,
    fields: { ...PR_STATUS, ...PR_COMMENTS },
  },
  {
    file: 'pr-view-full.json',
    description: 'Full pull request details (merged pull request; it has no labels).',
    args: (v) => [
      'pr',
      'view',
      String(v.mergedPullRequest),
      '--repo',
      v.repo,
      '--json',
      PR_FULL_FIELDS,
    ],
    output: 'json',
    trim: CHECKS_TRIM,
    fields: {
      ...PR_STATUS,
      ...AUTHOR,
      createdAt: 'time',
      ...PR_COMMENTS,
      'labels.id': 'id',
      'labels.name': 'keep',
      'labels.color': 'keep',
      'labels.description': 'text',
      additions: 'number',
      deletions: 'number',
      changedFiles: 'number',
    },
  },
  {
    file: 'pr-view-body.json',
    description: 'The pull request description, for adversarial review (merged pull request).',
    args: (v) => [
      'pr',
      'view',
      String(v.mergedPullRequest),
      '--repo',
      v.repo,
      '--json',
      'body',
      '--jq',
      '.body',
    ],
    output: 'text',
    text: 'body',
  },
  {
    file: 'pr-view-head-sha.json',
    description: 'The head commit, to anchor a review comment (open pull request).',
    args: (v) => [
      'pr',
      'view',
      String(v.openPullRequest),
      '--repo',
      v.repo,
      '--json',
      'headRefOid',
      '--jq',
      '.headRefOid',
    ],
    output: 'text',
    text: 'sha',
  },
  {
    file: 'api-pr-reviews.json',
    description: 'REST reviews, every page (merged pull request).',
    args: (v) => [
      'api',
      `repos/${v.repo}/pulls/${v.mergedPullRequest}/reviews?per_page=100`,
      '--paginate',
      '--slurp',
    ],
    output: 'json',
    fields: {
      id: 'id',
      node_id: 'id',
      ...REST_USER('user'),
      state: 'keep',
      submitted_at: 'time',
      body: 'text',
      author_association: 'keep',
      commit_id: 'sha',
    },
  },
  {
    file: 'api-pr-review-comments.json',
    description:
      'REST inline review comments, first page, newest update first (merged pull request).',
    args: (v) => [
      'api',
      `repos/${v.repo}/pulls/${v.mergedPullRequest}/comments?per_page=100&page=1&sort=updated&direction=desc`,
    ],
    output: 'json',
    trim: { limit: 3, select: lowestIds((comment) => comment.id) },
    fields: {
      id: 'id',
      node_id: 'id',
      pull_request_review_id: 'id',
      in_reply_to_id: 'id',
      ...REST_USER('user'),
      body: 'text',
      path: 'text',
      line: 'number',
      original_line: 'number',
      side: 'keep',
      created_at: 'time',
      updated_at: 'time',
      html_url: 'url',
      author_association: 'keep',
    },
  },
  {
    file: 'graphql-review-threads.json',
    description: 'Review threads and the database ids of their comments (merged pull request).',
    args: (v) => ['api', 'graphql', '-f', `query=${reviewThreadsQuery(v, v.mergedPullRequest)}`],
    output: 'json',
    trim: {
      path: 'data.repository.pullRequest.reviewThreads.nodes',
      limit: 3,
      select: lowestIds((thread) => thread.comments?.nodes?.[0]?.fullDatabaseId),
    },
    fields: {
      ...PAGE_INFO('data.repository.pullRequest.reviewThreads'),
      'data.repository.pullRequest.reviewThreads.nodes.id': 'id',
      'data.repository.pullRequest.reviewThreads.nodes.isResolved': 'keep',
      ...PAGE_INFO('data.repository.pullRequest.reviewThreads.nodes.comments'),
      'data.repository.pullRequest.reviewThreads.nodes.comments.nodes.fullDatabaseId': 'id',
    },
  },
  {
    file: 'graphql-thread-comments.json',
    description:
      "The next page of one review thread's comments, after the end cursor of the first recorded thread (an empty page: that thread has no further comments).",
    args: (v) => [
      'api',
      'graphql',
      '-f',
      `query=${threadCommentsQuery(v.threadId, v.threadCursor)}`,
    ],
    needs: ['threadId', 'threadCursor'],
    output: 'json',
    fields: {
      ...PAGE_INFO('data.node.comments'),
      'data.node.comments.nodes.fullDatabaseId': 'id',
    },
  },
  {
    file: 'graphql-open-prs.json',
    description: 'Open pull requests, for local branch matching.',
    args: (v) => ['api', 'graphql', '-f', `query=${openPullRequestsQuery(v)}`],
    output: 'json',
    trim: { path: 'data.repository.pullRequests.nodes', limit: 3 },
    fields: {
      ...PAGE_INFO('data.repository.pullRequests'),
      'data.repository.pullRequests.nodes.number': 'number',
      'data.repository.pullRequests.nodes.url': 'url',
      'data.repository.pullRequests.nodes.createdAt': 'time',
      'data.repository.pullRequests.nodes.headRefName': 'branch',
    },
  },
  {
    file: 'graphql-review-requests.json',
    description:
      'Review-request search, without the review-requested:@me qualifier (see deviation).',
    deviation:
      'The application searches `is:pr is:open review-requested:@me archived:false repo:<repo>`; the recording drops `review-requested:@me` so it reads no account data. Query, response shape and schema are otherwise the same.',
    args: (v) => ['api', 'graphql', '-f', `query=${reviewRequestsQuery(v.repo)}`],
    output: 'json',
    trim: { path: 'data.search.nodes', limit: 3 },
    fields: {
      ...PAGE_INFO('data.search'),
      'data.search.nodes.number': 'number',
      'data.search.nodes.title': 'text',
      'data.search.nodes.url': 'url',
      'data.search.nodes.isDraft': 'keep',
      'data.search.nodes.createdAt': 'time',
      'data.search.nodes.author.login': 'login',
      'data.search.nodes.repository.nameWithOwner': 'repo',
      'data.search.nodes.reviewDecision': 'keep',
      'data.search.nodes.additions': 'number',
      'data.search.nodes.deletions': 'number',
      'data.search.nodes.changedFiles': 'number',
    },
  },
  {
    file: 'issue-view-preview.json',
    description: 'Issue link preview.',
    args: (v) => [
      'issue',
      'view',
      String(v.issue),
      '--repo',
      v.repo,
      '--json',
      'title,state,author,createdAt',
    ],
    output: 'json',
    fields: { title: 'text', state: 'keep', ...AUTHOR, createdAt: 'time' },
  },
  {
    file: 'issue-view.json',
    description: 'One issue with its body.',
    args: (v) => [
      'issue',
      'view',
      String(v.issue),
      '--repo',
      v.repo,
      '--json',
      'number,title,body,url,state,createdAt,author',
    ],
    output: 'json',
    fields: {
      number: 'number',
      title: 'text',
      body: 'text',
      url: 'url',
      state: 'keep',
      createdAt: 'time',
      ...AUTHOR,
    },
  },
  {
    file: 'issue-list.json',
    description: 'Open issues for the Kanban board, without bodies (no assignee filter).',
    args: (v) => [
      'issue',
      'list',
      '--repo',
      v.repo,
      '--state',
      'open',
      '--json',
      'number,title,url,createdAt,author',
      '--limit',
      '50',
    ],
    output: 'json',
    trim: { limit: 3 },
    fields: { number: 'number', title: 'text', url: 'url', createdAt: 'time', ...AUTHOR },
  },
  {
    file: 'issue-list-search.json',
    description: 'Issue text search.',
    args: (v) => [
      'issue',
      'list',
      '--repo',
      v.repo,
      '--state',
      'open',
      '--search',
      v.issueSearch,
      '--limit',
      '30',
      '--json',
      'number,title,url,state,createdAt,author',
    ],
    output: 'json',
    trim: { limit: 3 },
    fields: {
      number: 'number',
      title: 'text',
      url: 'url',
      state: 'keep',
      createdAt: 'time',
      ...AUTHOR,
    },
  },
  {
    file: 'api-issue.json',
    description: 'REST issue, for an exact-number issue search.',
    args: (v) => ['api', `repos/${v.repo}/issues/${v.issue}`],
    output: 'json',
    fields: {
      id: 'id',
      number: 'number',
      title: 'text',
      html_url: 'url',
      state: 'keep',
      created_at: 'time',
      ...REST_USER('user'),
      pull_request: 'present',
    },
  },
  {
    file: 'api-repo.json',
    description: 'REST repository, for event-automation sources.',
    args: (v) => ['api', `repos/${v.repo}`],
    output: 'json',
    fields: { id: 'id', name: 'repo-name', full_name: 'repo', private: 'keep', has_issues: 'keep' },
  },
  {
    file: 'api-repo-labels.json',
    description: 'REST repository labels, every page, for event-automation sources.',
    args: (v) => ['api', `repos/${v.repo}/labels?per_page=100`, '--paginate', '--slurp'],
    output: 'json',
    trim: { limit: 5 },
    fields: REST_LABEL(''),
  },
  {
    file: 'api-issue-events.json',
    description:
      'REST issue events, one page with response headers, for event automations (see issueEventsPage in meta.json).',
    args: (v) => [
      'api',
      `repos/${v.repo}/issues/events?per_page=100&page=${v.issueEventsPage}`,
      '--include',
      '-H',
      'X-GitHub-Api-Version: 2022-11-28',
    ],
    output: 'http-json',
    trim: { limit: 6, select: issueEventsSelection },
    headers: ['content-type', 'link', 'x-github-api-version-selected'],
    fields: {
      id: 'id',
      node_id: 'id',
      event: 'keep',
      created_at: 'time',
      commit_id: 'sha',
      'actor.id': 'id',
      ...REST_USER('actor'),
      'label.name': 'keep',
      'label.color': 'keep',
      ...ISSUE_EVENT_ISSUE,
    },
  },
];
