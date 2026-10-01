import { execCommand } from '@/backend/lib/shell';
import { GH_TIMEOUT_MS, ghExecLimit } from './constants';

export interface AuthCheckResult {
  authenticated: boolean;
  user?: string;
  error?: string;
}

/**
 * Check if the GitHub CLI is authenticated, via the shared `gh` concurrency
 * limiter so this doesn't spawn processes outside the system-wide cap.
 */
export async function checkGithubAuth(): Promise<AuthCheckResult> {
  try {
    const result = await ghExecLimit(() =>
      execCommand('gh', ['auth', 'status'], { timeout: GH_TIMEOUT_MS.healthAuth })
    );
    // gh versions differ in which stream they use for auth status.
    const output = [result.stderr, result.stdout].filter(Boolean).join('\n');
    const userMatch = output.match(/Logged in to \S+ (?:account|as)\s+(\S+)/);

    // Older gh versions can exit zero even when a configured token is invalid.
    if (result.code === 0 && userMatch && !/Failed to log in/i.test(output)) {
      return { authenticated: true, user: userMatch[1] };
    }

    return { authenticated: false, error: output };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('ENOENT') || message.includes('not found')) {
      return {
        authenticated: false,
        error: 'GitHub CLI (gh) is not installed. Install it from https://cli.github.com',
      };
    }
    return { authenticated: false, error: message };
  }
}
