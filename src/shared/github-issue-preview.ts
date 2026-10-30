import { z } from 'zod';

export const githubIssuePreviewInputSchema = z.object({
  repo: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/),
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const githubIssuePreviewSchema = z.object({
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED']),
  author: z.object({ login: z.string() }).nullable(),
  createdAt: z.iso.datetime(),
});

export type GitHubIssuePreview = z.infer<typeof githubIssuePreviewSchema>;

/** Only public GitHub issue URLs qualify; the original URL remains the link target. */
export function parseGitHubIssueLink(href: string) {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password) {
      return null;
    }
    const match = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:\/|$)/.exec(url.pathname);
    if (!match) {
      return null;
    }
    const result = githubIssuePreviewInputSchema.safeParse({
      repo: `${match[1]}/${match[2]}`,
      number: Number(match[3]),
    });
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
