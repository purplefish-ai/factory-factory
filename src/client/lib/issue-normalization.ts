/**
 * Normalized issue type that works for both GitHub and Linear providers. It
 * has no body: the polled issue lists leave bodies out, and starting an issue
 * hands the agent its URL.
 */
export interface NormalizedIssue {
  id: string;
  displayId: string;
  title: string;
  url: string;
  createdAt: string;
  /** The user who opened the issue, not the assignee. */
  author: string;
  provider: 'github' | 'linear';
  githubIssueNumber?: number;
  linearIssueId?: string;
  linearIssueIdentifier?: string;
}

/** Raw GitHub issue shape from the tRPC list and search responses. */
export interface GitHubIssueRaw {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  author: { login: string };
}

/** Raw Linear issue shape from the tRPC list response. */
export interface LinearIssueRaw {
  id: string;
  identifier: string;
  title: string;
  url: string;
  createdAt: string;
  creatorName: string | null;
}

export function normalizeGitHubIssue(issue: GitHubIssueRaw): NormalizedIssue {
  return {
    id: String(issue.number),
    displayId: `#${issue.number}`,
    title: issue.title,
    url: issue.url,
    createdAt: issue.createdAt,
    author: issue.author.login,
    provider: 'github',
    githubIssueNumber: issue.number,
  };
}

export function normalizeLinearIssue(issue: LinearIssueRaw): NormalizedIssue {
  return {
    id: issue.id,
    displayId: issue.identifier,
    title: issue.title,
    url: issue.url,
    createdAt: issue.createdAt,
    author: issue.creatorName ?? 'Unknown',
    provider: 'linear',
    linearIssueId: issue.id,
    linearIssueIdentifier: issue.identifier,
  };
}
