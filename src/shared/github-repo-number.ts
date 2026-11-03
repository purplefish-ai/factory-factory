import { z } from 'zod';

export const githubRepoNumberSchema = z.object({
  repo: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/),
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

/**
 * HTTPS github.com only (including its default port), without credentials.
 * Host and issue/PR path keywords are case-insensitive; repository casing is
 * preserved. A positive safe integer may be followed by any slash-delimited
 * subpath, query or fragment. The original URL remains the navigation target.
 */
export function parseGitHubRepoNumberLink(href: string, kind: 'issues' | 'pull') {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password) {
      return null;
    }
    const match = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:\/|$)/i.exec(url.pathname);
    if (!match || match[3]?.toLowerCase() !== kind) {
      return null;
    }
    const result = githubRepoNumberSchema.safeParse({
      repo: `${match[1]}/${match[2]}`,
      number: Number(match[4]),
    });
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
