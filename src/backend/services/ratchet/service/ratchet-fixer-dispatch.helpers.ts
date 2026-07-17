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
  signal?: AbortSignal;
  commitSideEffects: () => void;
  onRecorded: () => void;
  onCleaned: () => void;
}): Promise<RatchetAction> {
  const {
    workspace,
    prStateInfo,
    retryCount,
    result,
    sessionBridge,
    signal,
    commitSideEffects,
    onRecorded,
    onCleaned,
  } = params;
  signal?.throwIfAborted();
  const promptSent = result.promptSent ?? true;
  if (!promptSent) {
    logger.warn('Ratchet session started but prompt delivery failed', {
      workspaceId: workspace.id,
      sessionId: result.sessionId,
    });
    signal?.throwIfAborted();
    await workspaceAccessor.update(workspace.id, { ratchetActiveSessionId: null });
    signal?.throwIfAborted();
    if (sessionBridge.isSessionRunning(result.sessionId)) {
      signal?.throwIfAborted();
      await sessionBridge.stopSession(result.sessionId);
      onCleaned();
      signal?.throwIfAborted();
    } else {
      onCleaned();
    }
    return { type: 'ERROR', error: 'Failed to deliver initial ratchet prompt' };
  }

  signal?.throwIfAborted();
  commitSideEffects();
  const recorded = await workspaceAccessor.recordRatchetDispatchIfEnabled(workspace.id, {
    sessionId: result.sessionId,
    snapshotKey: prStateInfo.snapshotKey,
    retryCount,
  });
  if (recorded) {
    onRecorded();
  }
  signal?.throwIfAborted();
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
  signal?: AbortSignal;
  commitSideEffects: () => void;
}): Promise<RatchetAction> {
  const { workspace, result, sessionBridge, signal, commitSideEffects } = params;
  // Adopt (pointer + RUNNING outcome) rather than record a full dispatch: the
  // session is working on an earlier prompt, so the current snapshot key must
  // not be marked as dispatched.
  signal?.throwIfAborted();
  commitSideEffects();
  const adopted = await workspaceAccessor.adoptRatchetActiveSessionIfEnabled(
    workspace.id,
    result.sessionId
  );
  signal?.throwIfAborted();
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

async function cleanUpUnrecordedStartedFixer(params: {
  workspaceId: string;
  sessionId: string;
  sessionBridge: RatchetSessionBridge;
}): Promise<void> {
  const { workspaceId, sessionId, sessionBridge } = params;
  try {
    await workspaceAccessor.recordRatchetSessionEnd(workspaceId, sessionId, 'COMPLETED');
  } catch (error) {
    logger.warn('Failed to settle unrecorded ratchet fixer during cleanup', {
      workspaceId,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    if (sessionBridge.isSessionRunning(sessionId)) {
      await sessionBridge.stopSession(sessionId);
    }
  } catch (error) {
    logger.warn('Failed to stop unrecorded ratchet fixer during cleanup', {
      workspaceId,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function triggerRatchetFixer(params: {
  workspace: WorkspaceWithPR;
  prStateInfo: PRStateInfo;
  retryCount: number;
  sessionBridge: RatchetSessionBridge;
  signal?: AbortSignal;
  commitSideEffects?: () => void;
}): Promise<RatchetAction> {
  const {
    workspace,
    prStateInfo,
    retryCount,
    sessionBridge,
    signal,
    commitSideEffects = () => {
      // Direct helper callers do not have a coordinator timeout to disable.
    },
  } = params;
  let result: AcquireAndDispatchResult | undefined;
  let startedFixerRecorded = false;
  let startedFixerCleaned = false;

  try {
    signal?.throwIfAborted();
    const userSettings = await userSettingsAccessor.get();
    signal?.throwIfAborted();
    result = await fixerSessionService.acquireAndDispatch({
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
        signal?.throwIfAborted();
        sessionBridge.injectCommittedUserMessage(sessionId, prompt);
      },
      afterStart: () => {
        commitSideEffects();
      },
    });
    signal?.throwIfAborted();

    if (result.status === 'started') {
      const action = await handleStartedFixerResult({
        workspace,
        prStateInfo,
        retryCount,
        result,
        sessionBridge,
        signal,
        commitSideEffects,
        onRecorded: () => {
          startedFixerRecorded = true;
        },
        onCleaned: () => {
          startedFixerCleaned = true;
        },
      });
      signal?.throwIfAborted();
      return action;
    }

    if (result.status === 'already_active') {
      return await handleAlreadyActiveFixerResult({
        workspace,
        result,
        sessionBridge,
        signal,
        commitSideEffects,
      });
    }

    if (result.status === 'skipped') {
      return { type: 'ERROR', error: result.reason };
    }

    return { type: 'ERROR', error: result.error };
  } catch (error) {
    if (result?.status === 'started' && !(startedFixerRecorded || startedFixerCleaned)) {
      await cleanUpUnrecordedStartedFixer({
        workspaceId: workspace.id,
        sessionId: result.sessionId,
        sessionBridge,
      });
    }
    signal?.throwIfAborted();
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to trigger ratchet fixer', toError(error), {
      workspaceId: workspace.id,
    });
    return { type: 'ERROR', error: errorMessage };
  }
}
