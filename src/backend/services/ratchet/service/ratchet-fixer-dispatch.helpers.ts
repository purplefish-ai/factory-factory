import { toError } from '@/backend/lib/error-utils';
import { buildRatchetDispatchPrompt } from '@/backend/prompts/ratchet-dispatch';
import type { createLogger } from '@/backend/services/logger.service';
import { userSettingsAccessor } from '@/backend/services/settings';
import type { RatchetSessionBridge } from './bridges';
import { type AcquireAndDispatchResult, fixerSessionService } from './fixer-session.service';
import type { PRStateInfo, RatchetAction, WorkspaceWithPR } from './ratchet.types';

type Logger = ReturnType<typeof createLogger>;

const RATCHET_WORKFLOW = 'ratchet';

async function recordActiveSessionOrDisable(params: {
  workspaceId: string;
  sessionId: string;
  setActiveSession: (workspaceId: string, sessionId: string) => Promise<boolean>;
  sessionBridge: RatchetSessionBridge;
  logger: Logger;
  logMessage: string;
}): Promise<RatchetAction | null> {
  const { workspaceId, sessionId, setActiveSession, sessionBridge, logger, logMessage } = params;
  const recorded = await setActiveSession(workspaceId, sessionId);
  if (recorded) {
    return null;
  }

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
  workspaceId: string;
  result: Extract<AcquireAndDispatchResult, { status: 'started' }>;
  sessionBridge: RatchetSessionBridge;
  setActiveSession: (workspaceId: string, sessionId: string) => Promise<boolean>;
  clearActiveSession: (workspaceId: string) => Promise<void>;
  logger: Logger;
}): Promise<RatchetAction> {
  const { workspaceId, result, sessionBridge, setActiveSession, clearActiveSession, logger } =
    params;
  const promptSent = result.promptSent ?? true;
  if (!promptSent) {
    logger.warn('Ratchet session started but prompt delivery failed', {
      workspaceId,
      sessionId: result.sessionId,
    });
    await clearActiveSession(workspaceId);
    if (sessionBridge.isSessionRunning(result.sessionId)) {
      await sessionBridge.stopSession(result.sessionId);
    }
    return { type: 'ERROR', error: 'Failed to deliver initial ratchet prompt' };
  }

  const disabledAction = await recordActiveSessionOrDisable({
    workspaceId,
    sessionId: result.sessionId,
    setActiveSession,
    sessionBridge,
    logger,
    logMessage: 'Ratchet disabled before fixer session could be recorded',
  });
  if (disabledAction) {
    return disabledAction;
  }

  return {
    type: 'TRIGGERED_FIXER',
    sessionId: result.sessionId,
    promptSent,
  };
}

async function handleAlreadyActiveFixerResult(params: {
  workspaceId: string;
  result: Extract<AcquireAndDispatchResult, { status: 'already_active' }>;
  sessionBridge: RatchetSessionBridge;
  setActiveSession: (workspaceId: string, sessionId: string) => Promise<boolean>;
  logger: Logger;
}): Promise<RatchetAction> {
  const { workspaceId, result, sessionBridge, setActiveSession, logger } = params;
  const disabledAction = await recordActiveSessionOrDisable({
    workspaceId,
    sessionId: result.sessionId,
    setActiveSession,
    sessionBridge,
    logger,
    logMessage: 'Ratchet disabled before active fixer session could be recorded',
  });
  if (disabledAction) {
    return disabledAction;
  }
  return { type: 'FIXER_ACTIVE', sessionId: result.sessionId };
}

export async function triggerRatchetFixer(params: {
  workspace: WorkspaceWithPR;
  prStateInfo: PRStateInfo;
  sessionBridge: RatchetSessionBridge;
  setActiveSession: (workspaceId: string, sessionId: string) => Promise<boolean>;
  clearActiveSession: (workspaceId: string) => Promise<void>;
  logger: Logger;
}): Promise<RatchetAction> {
  const { workspace, prStateInfo, sessionBridge, setActiveSession, clearActiveSession, logger } =
    params;

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
        workspaceId: workspace.id,
        result,
        sessionBridge,
        setActiveSession,
        clearActiveSession,
        logger,
      });
    }

    if (result.status === 'already_active') {
      return await handleAlreadyActiveFixerResult({
        workspaceId: workspace.id,
        result,
        sessionBridge,
        setActiveSession,
        logger,
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
