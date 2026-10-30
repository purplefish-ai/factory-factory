import { z } from 'zod';
import { getGitHubCLIErrorMessage } from '@/backend/lib/github-cli-error';
import { GH_TIMEOUT_MS } from './constants';
import { issueSchema } from './schemas';
import type { GitHubIssue } from './types';
import { parseGhJson } from './utils';

type Read = (args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;
const restIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.string(),
  state: z.enum(['open', 'closed']),
  created_at: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  pull_request: z.unknown().optional(),
});

// Repositories with Issues disabled have no issues to match: REST answers
// 410 Gone, while `gh issue list` reports it without an HTTP status.
const ISSUES_DISABLED = /\bHTTP 410\b|\brepository has disabled issues\b/i;
const ISSUE_NOT_FOUND = /\bHTTP 404\b/i;

async function orNoMatch(
  search: () => Promise<GitHubIssue[]>,
  ...noMatch: RegExp[]
): Promise<GitHubIssue[]> {
  try {
    return await search();
  } catch (error) {
    const message = getGitHubCLIErrorMessage(error);
    if (noMatch.some((pattern) => pattern.test(message))) {
      return [];
    }
    throw error;
  }
}

async function lookupIssueNumber(
  read: Read,
  owner: string,
  repo: string,
  number: string
): Promise<GitHubIssue[]> {
  const { stdout } = await read(['api', `repos/${owner}/${repo}/issues/${number}`], {
    timeout: GH_TIMEOUT_MS.default,
  });
  const issue = parseGhJson(restIssueSchema, stdout, 'searchIssueNumber');
  // GitHub's REST issues endpoint also returns pull requests.
  return issue.pull_request !== undefined
    ? []
    : [
        {
          number: issue.number,
          title: issue.title,
          body: issue.body ?? '',
          url: issue.html_url,
          state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
          createdAt: issue.created_at,
          author: { login: issue.user?.login ?? 'Unknown' },
        },
      ];
}

async function listMatchingIssues(
  read: Read,
  owner: string,
  repo: string,
  query: string,
  limit: number
): Promise<GitHubIssue[]> {
  const { stdout } = await read(
    [
      'issue',
      'list',
      '--repo',
      `${owner}/${repo}`,
      '--state',
      'open',
      '--search',
      query,
      '--limit',
      String(limit),
      '--json',
      'number,title,body,url,state,createdAt,author',
    ],
    { timeout: GH_TIMEOUT_MS.default }
  );
  return parseGhJson(issueSchema.array(), stdout, 'searchIssues');
}

export function searchIssues(
  read: Read,
  owner: string,
  repo: string,
  query: string,
  limit: number
): Promise<GitHubIssue[]> {
  const number = /^#?(\d+)$/.exec(query)?.[1];
  return number
    ? orNoMatch(
        () => lookupIssueNumber(read, owner, repo, number),
        ISSUE_NOT_FOUND,
        ISSUES_DISABLED
      )
    : orNoMatch(() => listMatchingIssues(read, owner, repo, query, limit), ISSUES_DISABLED);
}
