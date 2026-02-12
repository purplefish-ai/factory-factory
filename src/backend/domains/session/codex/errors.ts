export class SessionOperationError extends Error {
  readonly code: string;
  readonly metadata: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(
    message: string,
    options?: {
      code?: string;
      metadata?: Record<string, unknown>;
      retryable?: boolean;
      cause?: Error;
    }
  ) {
    super(message);
    this.name = 'SessionOperationError';
    this.code = options?.code ?? 'SESSION_OPERATION_FAILED';
    this.metadata = options?.metadata ?? {};
    this.retryable = options?.retryable ?? false;
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

export class CodexManagerUnavailableError extends SessionOperationError {
  constructor(reason: string, retryable = true) {
    super(`Codex app-server unavailable: ${reason}`, {
      code: 'CODEX_MANAGER_UNAVAILABLE',
      metadata: { reason },
      retryable,
    });
    this.name = 'CodexManagerUnavailableError';
  }
}

export function createUnsupportedOperationError(operation: string): SessionOperationError {
  return new SessionOperationError(`Operation not supported by Codex provider: ${operation}`, {
    code: 'UNSUPPORTED_OPERATION',
    metadata: { operation },
  });
}
