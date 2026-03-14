import { createLogger } from '@/backend/services/logger.service';

const logger = createLogger('session');

export type SessionRetryOptions = {
  attempts: number;
  operationName: string;
  context?: Record<string, unknown>;
};

export class SessionRetryService {
  async run<T>(operation: () => Promise<T>, options: SessionRetryOptions): Promise<T> {
    const maxAttempts = Math.max(1, options.attempts);
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        return await operation();
      } catch (error) {
        if (attempt >= maxAttempts) {
          throw error;
        }

        logger.warn('Session operation failed; retrying', {
          operationName: options.operationName,
          attempt,
          maxAttempts,
          error: error instanceof Error ? error.message : String(error),
          ...(options.context ?? {}),
        });
      }
    }

    throw new Error(`Unreachable retry state for operation ${options.operationName}`);
  }
}
