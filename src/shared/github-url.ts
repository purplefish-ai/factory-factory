export interface GithubRepo {
  owner: string;
  repo: string;
}

const GITHUB_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function isValidGithubPathSegment(segment: string): boolean {
  return GITHUB_PATH_SEGMENT_PATTERN.test(segment);
}

/**
 * Parse a GitHub URL into owner and repo.
 * Accepts:
 * - HTTPS: https://github.com/owner/repo or https://github.com/owner/repo.git
 * - SSH: git@github.com:owner/repo or git@github.com:owner/repo.git
 */
export function parseGithubUrl(url: string): GithubRepo | null {
  // Try HTTPS format first
  let match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);

  // Try SSH format if HTTPS didn't match
  if (!match) {
    match = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  }

  if (!match) {
    return null;
  }

  const owner = match[1] as string;
  const repo = match[2] as string;
  if (!(isValidGithubPathSegment(owner) && isValidGithubPathSegment(repo))) {
    return null;
  }

  return { owner, repo };
}
