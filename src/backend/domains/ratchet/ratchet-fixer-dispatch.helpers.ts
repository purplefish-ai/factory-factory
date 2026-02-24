import { buildRatchetDispatchPrompt } from '@/backend/prompts/ratchet-dispatch';
import type { createLogger } from '@/backend/services/logger.service';
import type { RatchetSessionBridge } from './bridges';
import { fixerSessionService } from './fixer-session.service';
import type { PRStateInfo, RatchetAction, WorkspaceWithPR } from './ratchet.types';

type Logger = ReturnType<typeof createLogger>;

const RATCHET_WORKFLOW = 'ratchet';

export async function triggerRatchetFixer(params: {
  workspace: WorkspaceWithPR;
  prStateInfo: PRStateInfo;
  sessionBridge: RatchetSessionBridge;
  setActiveSession: (workspaceId: string, sessionId: string) => Promise<void>;
  clearActiveSession: (workspaceId: string) => Promise<void>;
  logger: Logger;
}): Promise<RatchetAction> {
  const { workspace, prStateInfo, sessionBridge, setActiveSession, clearActiveSession, logger } =
    params;

  try {
    const result = await fixerSessionService.acquireAndDispatch({
      workspaceId: workspace.id,
      workflow: RATCHET_WORKFLOW,
      sessionName: 'Ratchet',
      runningIdleAction: 'restart',
      dispatchMode: 'start_empty_and_send',
      buildPrompt: () =>
        buildRatchetDispatchPrompt(
          workspace.prUrl,
          prStateInfo.prNumber,
          prStateInfo.reviewComments
        ),
      beforeStart: ({ sessionId, prompt }) => {
        sessionBridge.injectCommittedUserMessage(sessionId, prompt);
      },
    });

    if (result.status === 'started') {
      const promptSent = result.promptSent ?? true;
      if (!promptSent) {
        logger.warn('Ratchet session started but prompt delivery failed', {
          workspaceId: workspace.id,
          sessionId: result.sessionId,
        });
        await clearActiveSession(workspace.id);
        if (sessionBridge.isSessionRunning(result.sessionId)) {
          await sessionBridge.stopSession(result.sessionId);
        }
        return { type: 'ERROR', error: 'Failed to deliver initial ratchet prompt' };
      }

      await setActiveSession(workspace.id, result.sessionId);

      return {
        type: 'TRIGGERED_FIXER',
        sessionId: result.sessionId,
        promptSent,
      };
    }

    if (result.status === 'already_active') {
      await setActiveSession(workspace.id, result.sessionId);
      return { type: 'FIXER_ACTIVE', sessionId: result.sessionId };
    }

    if (result.status === 'skipped') {
      return { type: 'ERROR', error: result.reason };
    }

    return { type: 'ERROR', error: result.error };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to trigger ratchet fixer', error as Error, {
      workspaceId: workspace.id,
    });
    return { type: 'ERROR', error: errorMessage };
  }
}
