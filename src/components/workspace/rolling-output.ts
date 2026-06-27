export const WORKSPACE_LOG_OUTPUT_MAX_CHARS = 512 * 1024;
export const TERMINAL_OUTPUT_MAX_CHARS = 128 * 1024;

export const WORKSPACE_LOG_TRUNCATION_MARKER = '[Earlier output truncated]\n';
export const TERMINAL_TRUNCATION_MARKER = '\r\n[Earlier terminal output truncated]\r\n';

interface RollingOutputOptions {
  maxChars: number;
  truncationMarker: string;
}

export function appendToRollingOutput(
  current: string,
  next: string,
  { maxChars, truncationMarker }: RollingOutputOptions
): string {
  if (maxChars <= 0) {
    return '';
  }

  const wasTruncated = current.startsWith(truncationMarker);
  const currentBody = wasTruncated ? current.slice(truncationMarker.length) : current;
  const combinedBody = currentBody + next;

  if (!wasTruncated && combinedBody.length <= maxChars) {
    return combinedBody;
  }

  const boundedMarker = truncationMarker.slice(0, maxChars);
  const maxBodyChars = maxChars - boundedMarker.length;
  if (maxBodyChars <= 0) {
    return boundedMarker;
  }

  return boundedMarker + combinedBody.slice(-maxBodyChars);
}

export function trimRollingOutput(output: string, options: RollingOutputOptions): string {
  return appendToRollingOutput('', output, options);
}
