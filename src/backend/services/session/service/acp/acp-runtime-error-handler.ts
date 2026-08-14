import type { ChildProcess } from 'node:child_process';
import { createLogger } from '@/backend/services/logger.service';
import type { AcpRuntimeEventHandlers, AcpRuntimePurpose } from './acp-runtime-events';
import { normalizeUnknownError } from './acp-stream-normalizer';

const logger = createLogger('acp-runtime-manager');

export function wireAcpRuntimeErrorHandler(
  child: ChildProcess,
  sessionId: string,
  handlers: AcpRuntimeEventHandlers,
  getPurpose: () => AcpRuntimePurpose
): void {
  child.on('error', async (error) => {
    const normalizedError = normalizeUnknownError(error);
    if (!(handlers.onRuntimeError || handlers.onError)) {
      logger.warn('ACP child process error (no handler provided)', {
        sessionId,
        error: normalizedError.message,
      });
      return;
    }

    try {
      if (handlers.onRuntimeError) {
        await handlers.onRuntimeError({ sessionId, error: normalizedError, purpose: getPurpose() });
      } else {
        await handlers.onError?.(sessionId, normalizedError);
      }
    } catch (handlerError) {
      logger.warn('Failed to handle ACP error event', {
        sessionId,
        originalError: normalizedError.message,
        handlerError: handlerError instanceof Error ? handlerError.message : String(handlerError),
      });
    }
  });
}
