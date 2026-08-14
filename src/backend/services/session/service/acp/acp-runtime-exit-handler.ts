import { createLogger } from '@/backend/services/logger.service';
import type { AcpRuntimeEventHandlers, AcpRuntimeExitEvent } from './acp-runtime-events';

const logger = createLogger('acp-runtime-manager');

export function createExitFence(): readonly [Promise<void>, () => void] {
  let release!: () => void;
  const fence = new Promise<void>((resolve) => {
    release = resolve;
  });
  return [fence, release];
}

export async function dispatchAcpRuntimeExit(
  handlers: AcpRuntimeEventHandlers,
  event: AcpRuntimeExitEvent
): Promise<void> {
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
}
