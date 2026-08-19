import type { ChildProcess } from 'node:child_process';
import { createLogger } from '@/backend/services/logger.service';
import type { AcpRuntimeMetadata } from './acp-runtime-contracts';
import type { AcpRuntimeEventHandlers } from './acp-runtime-events';
import { normalizeUnknownError } from './acp-stream-normalizer';

const logger = createLogger('acp-runtime-manager');

export function wireAcpRuntimeErrorHandler(
  child: ChildProcess,
  sessionId: string,
  handlers: AcpRuntimeEventHandlers,
  runtime: Pick<AcpRuntimeMetadata, 'incarnationId' | 'purpose'>,
  shouldDispatch: () => boolean
): void {
  child.on('error', async (error) => {
    const normalizedError = normalizeUnknownError(error);
    if (!shouldDispatch()) {
      return;
    }
    if (!(handlers.onRuntimeError || handlers.onError)) {
      logger.warn('ACP child process error (no handler provided)', {
        sessionId,
        error: normalizedError.message,
      });
      return;
    }

    try {
      if (handlers.onRuntimeError) {
        await handlers.onRuntimeError({
          sessionId,
          error: normalizedError,
          incarnationId: runtime.incarnationId,
          purpose: runtime.purpose,
        });
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
