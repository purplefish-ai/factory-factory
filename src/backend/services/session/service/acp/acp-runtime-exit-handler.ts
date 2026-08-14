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
      if (handlers.onRuntimeExit) {
        await handlers.onRuntimeExit(event);
      } else if (!event.managed && handlers.onExit) {
        await handlers.onExit(event.sessionId, event.exitCode);
      }
    } catch (error) {
      logger.warn('Failed to handle ACP exit event', {
        sessionId: event.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
