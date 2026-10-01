import { createLogger } from '@/backend/services/logger.service';
import {
  chatMessageHandlerService,
  sessionDataService,
  sessionDomainService,
} from '@/backend/services/session';

const logger = createLogger('workspace-wake-delivery-orchestrator');

/**
 * Resume a workspace's own session with `prompt`, as a new turn.
 *
 * Unlike `deliverWorkspaceNotification`, this does **not** filter sessions to
 * `RUNNING`/`IDLE`: "wake up" by definition targets a workspace whose session
 * is dormant, so the most recently updated session is picked regardless of
 * status, and `tryDispatchNextMessage`'s own auto-start path
 * (`chat-message-handlers.service.ts`) is what resumes a stopped session's ACP
 * client.
 */
export async function deliverWorkspaceWake(
  workspaceId: string,
  prompt: string
): Promise<{ delivered: boolean }> {
  const sessions = await sessionDataService.findAgentSessionsByWorkspaceId(workspaceId);
  const mostRecentSession = [...sessions].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
  )[0];
  if (!mostRecentSession) {
    return { delivered: false };
  }

  const enqueueResult = sessionDomainService.enqueue(mostRecentSession.id, {
    id: `wake-${workspaceId}-${Date.now()}`,
    text: prompt,
    timestamp: new Date().toISOString(),
    settings: {
      selectedModel: null,
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  });
  if ('error' in enqueueResult) {
    logger.warn('deliverWorkspaceWake: enqueue failed', {
      workspaceId,
      sessionId: mostRecentSession.id,
      error: enqueueResult.error,
    });
    return { delivered: false };
  }

  await chatMessageHandlerService.tryDispatchNextMessage(mostRecentSession.id);
  return { delivered: true };
}
