export class PromptTimeoutError extends Error {
  constructor(
    sessionId: string,
    public readonly timeoutMs: number
  ) {
    super(`ACP prompt timed out after ${timeoutMs}ms for session ${sessionId}`);
    this.name = 'PromptTimeoutError';
  }
}

export class AcpBrowseSessionUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AcpBrowseSessionUnavailableError';
  }
}

export type AcpSubagentBrowseErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'PRECONDITION_FAILED'
  | 'INTERNAL_ERROR';

export class AcpSubagentBrowseError extends Error {
  constructor(
    public readonly code: AcpSubagentBrowseErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AcpSubagentBrowseError';
  }
}

export type AcpErrorLogDetails = { message: string; code?: number | string; data?: unknown };

function getAcpErrorMetadata(error: {
  code?: unknown;
  data?: unknown;
}): Omit<AcpErrorLogDetails, 'message'> {
  const code =
    typeof error.code === 'number' || typeof error.code === 'string' ? error.code : undefined;
  return {
    ...(code !== undefined ? { code } : {}),
    ...(typeof error.data !== 'undefined' ? { data: error.data } : {}),
  };
}

function stringifyAcpError(error: object): string {
  try {
    const serialized = JSON.stringify(error);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Fall through to the object's string representation.
  }
  try {
    return String(error);
  } catch {
    return 'Unknown ACP error';
  }
}

export function getAcpErrorLogDetails(error: unknown): AcpErrorLogDetails {
  if (error instanceof Error) {
    const maybe = error as Error & { code?: unknown; data?: unknown };
    return {
      message: error.message,
      ...getAcpErrorMetadata(maybe),
    };
  }

  if (typeof error === 'object' && error !== null) {
    const maybe = error as { message?: unknown; code?: unknown; data?: unknown };
    const message = typeof maybe.message === 'string' ? maybe.message : stringifyAcpError(error);
    return {
      message,
      ...getAcpErrorMetadata(maybe),
    };
  }

  return { message: String(error) };
}

export function createAcpResumeError(
  provider: string,
  providerSessionId: string,
  error: unknown
): Error {
  const { message, data, code } = getAcpErrorLogDetails(error);
  const detail =
    typeof data === 'object' &&
    data !== null &&
    'details' in data &&
    typeof data.details === 'string'
      ? data.details
      : undefined;
  const recovery = isAcpSessionInUseError(error)
    ? 'Close the session in the other client or stop the other Factory Factory backend, then retry.'
    : 'Restore the provider history before retrying.';
  return new Error(
    `Cannot restore existing ${provider} conversation "${providerSessionId}": ${message}${code !== undefined ? ` [code ${code}]` : ''}${detail ? ` (${detail})` : ''}. ${recovery}`,
    { cause: error }
  );
}

export function isAcpSessionInUseError(error: unknown): boolean {
  const { data } = getAcpErrorLogDetails(error);
  return (
    typeof data === 'object' &&
    data !== null &&
    'reason' in data &&
    data.reason === 'thread_active_writer'
  );
}

export function isMethodNotFoundError(error: unknown): boolean {
  const details = getAcpErrorLogDetails(error);
  return details.code === -32_601 || details.message.includes('Method not found');
}
