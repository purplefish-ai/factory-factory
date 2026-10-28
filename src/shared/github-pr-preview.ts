import { z } from 'zod';

export const githubPRPreviewInputSchema = z.object({
  repo: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/),
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

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

/** Only public GitHub PR URLs qualify; the original URL remains the link target. */
export function parseGitHubPRLink(href: string) {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password) {
      return null;
    }
    const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/.exec(url.pathname);
    if (!match) {
      return null;
    }
    const result = githubPRPreviewInputSchema.safeParse({
      repo: `${match[1]}/${match[2]}`.toLowerCase(),
      number: Number(match[3]),
    });
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
