import { z } from 'zod';
import { githubRepoNumberSchema, parseGitHubRepoNumberLink } from './github-repo-number';

export const githubIssuePreviewInputSchema = githubRepoNumberSchema;

export const githubIssuePreviewSchema = z.object({
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED']),
  author: z.object({ login: z.string() }).nullable(),
  createdAt: z.iso.datetime(),
});

export type GitHubIssuePreview = z.infer<typeof githubIssuePreviewSchema>;

/** See parseGitHubRepoNumberLink for the shared URL policy. */
export function parseGitHubIssueLink(href: string) {
  return parseGitHubRepoNumberLink(href, 'issues');
}
