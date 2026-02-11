import { createLogger } from '@/backend/services/logger.service';
import { isRateLimitMessage } from '@/backend/services/rate-limit-backoff';
import type { GitHubCLIErrorType } from './types';

const logger = createLogger('github-cli');

function isCliNotInstalledError(message: string): boolean {
  return message.includes('enoent') || message.includes('not found');
}

function isAuthRequiredError(message: string): boolean {
  return (
    message.includes('authentication') ||
    message.includes('not logged in') ||
    message.includes('gh auth login')
  );
}

function isPRNotFoundError(message: string): boolean {
  return message.includes('could not resolve') || message.includes('not found');
}

function isNetworkError(message: string): boolean {
  return (
    message.includes('network') || message.includes('timeout') || message.includes('connection')
  );
}

function isRateLimitError(message: string): boolean {
  return isRateLimitMessage(message);
}

/**
 * Classify an error from gh CLI execution.
 */
export function classifyError(error: unknown): GitHubCLIErrorType {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  if (isCliNotInstalledError(lowerMessage)) {
    return 'cli_not_installed';
  }

  if (isAuthRequiredError(lowerMessage)) {
    return 'auth_required';
  }

  if (isPRNotFoundError(lowerMessage)) {
    return 'pr_not_found';
  }

  if (isRateLimitError(lowerMessage)) {
    return 'rate_limit';
  }

  if (isNetworkError(lowerMessage)) {
    return 'network_error';
  }

  return 'unknown';
}

/**
 * Log error with appropriate level and hint based on error type.
 */
export function logGitHubCLIError(
  errorType: GitHubCLIErrorType,
  errorMessage: string,
  context: Record<string, unknown>
): void {
  if (errorType === 'cli_not_installed') {
    logger.error('GitHub CLI configuration issue', {
      ...context,
      errorType,
      error: errorMessage,
      hint: 'Install gh CLI from https://cli.github.com/',
    });
  } else if (errorType === 'auth_required') {
    logger.error('GitHub CLI configuration issue', {
      ...context,
      errorType,
      error: errorMessage,
      hint: 'Run `gh auth login` to authenticate',
    });
  } else if (errorType === 'pr_not_found') {
    logger.warn('PR not found', { ...context, errorType });
  } else if (errorType === 'rate_limit') {
    logger.warn('GitHub API rate limit hit', {
      ...context,
      errorType,
      error: errorMessage,
      hint: 'Polling intervals have been increased to reduce API pressure',
    });
  } else {
    logger.error('Failed to fetch PR status via gh CLI', {
      ...context,
      errorType,
      error: errorMessage,
    });
  }
}
