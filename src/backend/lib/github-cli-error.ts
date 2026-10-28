/** Only the GitHub process boundary creates this retryable failure. */
export class GitHubConnectivityError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'GitHubConnectivityError';
  }
}

/** Command arguments can contain words like "network"; classify diagnostics only. */
export function getGitHubCLIErrorMessage(error: unknown): string {
  const stderr =
    typeof error === 'object' &&
    error !== null &&
    'stderr' in error &&
    typeof error.stderr === 'string'
      ? error.stderr.trim()
      : '';
  const message = stderr || (error instanceof Error ? error.message : String(error));
  return message.replace(/^Command failed:[^\r\n]*(?:\r?\n|$)/i, '').trim();
}

/** execFile's default timeout kill has no timeout text; buffer overflows have a code. */
export function isGitHubCLIReadTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'killed' in error &&
    error.killed === true &&
    'signal' in error &&
    error.signal === 'SIGTERM' &&
    'code' in error &&
    error.code === null
  );
}
