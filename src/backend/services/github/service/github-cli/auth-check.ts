import { execCommand } from '@/backend/lib/shell';
import { ghExecLimit } from './constants';

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
    const result = await ghExecLimit(() => execCommand('gh', ['auth', 'status']));
    // gh auth status writes to stderr on success
    const output = result.stderr || result.stdout;

    if (result.code === 0) {
      const userMatch = output.match(/account\s+(\S+)/);
      return { authenticated: true, user: userMatch?.[1] };
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
