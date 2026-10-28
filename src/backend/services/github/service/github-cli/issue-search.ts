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

export async function searchIssues(
  read: Read,
  owner: string,
  repo: string,
  query: string,
  limit: number
): Promise<GitHubIssue[]> {
  const number = /^#?(\d+)$/.exec(query)?.[1];
  if (number) {
    try {
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
    } catch (error) {
      if (/\bHTTP 404\b/i.test(getGitHubCLIErrorMessage(error))) {
        return [];
      }
      throw error;
    }
  }
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
