import { createLogger } from '@/backend/services/logger.service';
import type {
  SessionCallerGuard,
  SessionLifecycleMessageQueueBridge,
} from '@/backend/services/session/service/bridges';
import type { StartSessionOptions } from './session-startup-options';

const logger = createLogger('session');

export async function dispatchStartupNotifications(
  bridge: SessionLifecycleMessageQueueBridge | null,
  sessionId: string,
  dispatchableCount: number,
  options?: Pick<StartSessionOptions, 'assertCurrent' | 'assertCurrentSync'>
): Promise<void> {
  if (dispatchableCount === 0 || !bridge) {
    return;
  }
  // Preserve the exact callbacks already captured by this startup, including the
  // workspace caller. The notification's ordinary session origin cannot replace them.
  const guard = startupCallerGuard(options);
  try {
    await bridge.tryDispatchNextMessage(sessionId, ...(guard ? ([{ guard }] as const) : []));
  } catch (error) {
    logger.warn('Failed to dispatch queued workspace notifications', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function startupCallerGuard(
  options?: Pick<StartSessionOptions, 'assertCurrent' | 'assertCurrentSync'>
): SessionCallerGuard | undefined {
  return options?.assertCurrent
    ? {
        check: options.assertCurrent,
        ...(options.assertCurrentSync && { assertCurrent: options.assertCurrentSync }),
      }
    : undefined;
}
