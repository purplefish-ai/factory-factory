/** Normalized issue type that works for both GitHub and Linear providers. */
export interface NormalizedIssue {
  id: string;
  displayId: string;
  title: string;
  body: string;
  url: string;
  createdAt: string;
  author: string;
  provider: 'github' | 'linear';
  githubIssueNumber?: number;
  linearIssueId?: string;
  linearIssueIdentifier?: string;
}

/** Raw GitHub issue shape from the tRPC response. */
export interface GitHubIssueRaw {
  number: number;
  title: string;
  body: string;
  url: string;
  state: 'OPEN' | 'CLOSED';
  createdAt: string;
  author: { login: string };
}

/** Raw Linear issue shape from the tRPC response. */
export interface LinearIssueRaw {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  state: string;
  createdAt: string;
  assigneeName: string | null;
}

export function normalizeGitHubIssue(issue: GitHubIssueRaw): NormalizedIssue {
  return {
    id: String(issue.number),
    displayId: `#${issue.number}`,
    title: issue.title,
    body: issue.body,
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
    body: issue.description,
    url: issue.url,
    createdAt: issue.createdAt,
    author: issue.assigneeName ?? 'Unassigned',
    provider: 'linear',
    linearIssueId: issue.id,
    linearIssueIdentifier: issue.identifier,
  };
}
