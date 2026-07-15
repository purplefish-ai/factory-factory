import { toError } from '@/backend/lib/error-utils';
import { buildRatchetDispatchPrompt } from '@/backend/prompts/ratchet-dispatch';
import { createLogger } from '@/backend/services/logger.service';
import { userSettingsAccessor } from '@/backend/services/settings';
import { workspaceAccessor } from '@/backend/services/workspace';
import type { RatchetSessionBridge } from './bridges';
import { type AcquireAndDispatchResult, fixerSessionService } from './fixer-session.service';
import type { PRStateInfo, RatchetAction, WorkspaceWithPR } from './ratchet.types';

const logger = createLogger('ratchet');

const RATCHET_WORKFLOW = 'ratchet';

/**
 * React to a lost disable-vs-dispatch race: the conditional accessor refused
 * to record the session because ratcheting was disabled mid-dispatch, so the
 * freshly started/adopted session must be stopped again.
 */
async function stopUnrecordedFixerSession(params: {
  workspaceId: string;
  sessionId: string;
  sessionBridge: RatchetSessionBridge;
  logMessage: string;
}): Promise<RatchetAction> {
  const { workspaceId, sessionId, sessionBridge, logMessage } = params;
  logger.info(logMessage, {
    workspaceId,
    sessionId,
  });
  if (sessionBridge.isSessionRunning(sessionId)) {
    await sessionBridge.stopSession(sessionId);
  }
  return { type: 'DISABLED', reason: 'Workspace ratcheting disabled' };
}

async function handleStartedFixerResult(params: {
  workspace: WorkspaceWithPR;
  prStateInfo: PRStateInfo;
  retryCount: number;
  result: Extract<AcquireAndDispatchResult, { status: 'started' }>;
  sessionBridge: RatchetSessionBridge;
}): Promise<RatchetAction> {
  const { workspace, prStateInfo, retryCount, result, sessionBridge } = params;
  const promptSent = result.promptSent ?? true;
  if (!promptSent) {
    logger.warn('Ratchet session started but prompt delivery failed', {
      workspaceId: workspace.id,
      sessionId: result.sessionId,
    });
    await workspaceAccessor.update(workspace.id, { ratchetActiveSessionId: null });
    if (sessionBridge.isSessionRunning(result.sessionId)) {
      await sessionBridge.stopSession(result.sessionId);
    }
    return { type: 'ERROR', error: 'Failed to deliver initial ratchet prompt' };
  }

  const recorded = await workspaceAccessor.recordRatchetDispatchIfEnabled(workspace.id, {
    sessionId: result.sessionId,
    snapshotKey: prStateInfo.snapshotKey,
    retryCount,
  });
  if (!recorded) {
    return await stopUnrecordedFixerSession({
      workspaceId: workspace.id,
      sessionId: result.sessionId,
      sessionBridge,
      logMessage: 'Ratchet disabled before fixer session could be recorded',
    });
  }

  return {
    type: 'TRIGGERED_FIXER',
    sessionId: result.sessionId,
    promptSent,
  };
}

async function handleAlreadyActiveFixerResult(params: {
  workspace: WorkspaceWithPR;
  result: Extract<AcquireAndDispatchResult, { status: 'already_active' }>;
  sessionBridge: RatchetSessionBridge;
}): Promise<RatchetAction> {
  const { workspace, result, sessionBridge } = params;
  // Adopt (pointer + RUNNING outcome) rather than record a full dispatch: the
  // session is working on an earlier prompt, so the current snapshot key must
  // not be marked as dispatched.
  const adopted = await workspaceAccessor.adoptRatchetActiveSessionIfEnabled(
    workspace.id,
    result.sessionId
  );
  if (!adopted) {
    return await stopUnrecordedFixerSession({
      workspaceId: workspace.id,
      sessionId: result.sessionId,
      sessionBridge,
      logMessage: 'Ratchet disabled before active fixer session could be recorded',
    });
  }
  return { type: 'FIXER_ACTIVE', sessionId: result.sessionId };
}

export async function triggerRatchetFixer(params: {
  workspace: WorkspaceWithPR;
  prStateInfo: PRStateInfo;
  retryCount: number;
  sessionBridge: RatchetSessionBridge;
}): Promise<RatchetAction> {
  const { workspace, prStateInfo, retryCount, sessionBridge } = params;

  try {
    const userSettings = await userSettingsAccessor.get();
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
          prStateInfo.reviewComments,
          {
            hasMergeConflict: prStateInfo.hasMergeConflict,
            replyToPrComments: userSettings.ratchetReplyToPrComments,
          }
        ),
      beforeStart: ({ sessionId, prompt }) => {
        sessionBridge.injectCommittedUserMessage(sessionId, prompt);
      },
    });

    if (result.status === 'started') {
      return await handleStartedFixerResult({
        workspace,
        prStateInfo,
        retryCount,
        result,
        sessionBridge,
      });
    }

    if (result.status === 'already_active') {
      return await handleAlreadyActiveFixerResult({
        workspace,
        result,
        sessionBridge,
      });
    }

    if (result.status === 'skipped') {
      return { type: 'ERROR', error: result.reason };
    }

    return { type: 'ERROR', error: result.error };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to trigger ratchet fixer', toError(error), {
      workspaceId: workspace.id,
    });
    return { type: 'ERROR', error: errorMessage };
  }
}
