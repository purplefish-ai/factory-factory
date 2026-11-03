import { z } from 'zod';
import { githubRepoNumberSchema, parseGitHubRepoNumberLink } from './github-repo-number';

export const githubPRPreviewInputSchema = githubRepoNumberSchema;

export const githubPRPreviewSchema = z.object({
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  author: z.object({ login: z.string() }).nullable(),
  createdAt: z.iso.datetime(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
});

export type GitHubPRPreview = z.infer<typeof githubPRPreviewSchema>;

/** See parseGitHubRepoNumberLink for the shared URL policy. */
export function parseGitHubPRLink(href: string) {
  return parseGitHubRepoNumberLink(href, 'pull');
}
