import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from '@/backend/services/logger.service';
import type { AcpRuntimeEventHandlers, AcpRuntimeExitEvent } from './acp-runtime-events';

const logger = createLogger('acp-runtime-manager');
const exitHandlerSession = new AsyncLocalStorage<string>();

export function guardExit(sessionId: string): void {
  if (exitHandlerSession.getStore() === sessionId) {
    throw new Error(
      `Cannot create ACP client for session ${sessionId} from its runtime exit handler`
    );
  }
}

export function createExitFence(): readonly [Promise<void>, () => void] {
  let release!: () => void;
  const fence = new Promise<void>((resolve) => {
    release = resolve;
  });
  return [fence, release];
}

export function dispatchAcpRuntimeExit(
  handlers: AcpRuntimeEventHandlers,
  event: AcpRuntimeExitEvent
): Promise<void> {
  return exitHandlerSession.run(event.sessionId, async () => {
    try {
      await handlers.onRuntimeExit?.(event);
    } catch (error) {
      logger.warn('Failed to handle ACP exit event', {
        sessionId: event.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

/** Current-incarnation group cleanup precedes durable exit observation, even when that observation fails. */
export async function dispatchExitAfterCleanup(
  handlers: AcpRuntimeEventHandlers,
  event: AcpRuntimeExitEvent,
  cleanup: () => Promise<void>
): Promise<void> {
  if (!event.managed) {
    await cleanup().catch(() => {
      logger.warn('Event exit runtime cleanup is unconfirmed', { sessionId: event.sessionId });
    });
  }
  await dispatchAcpRuntimeExit(handlers, event);
}
