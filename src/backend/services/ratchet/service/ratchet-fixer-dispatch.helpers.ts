import { toError } from '@/backend/lib/error-utils';
import { buildRatchetDispatchPrompt } from '@/backend/prompts/ratchet-dispatch';
import { createLogger } from '@/backend/services/logger.service';
import { userSettingsService } from '@/backend/services/settings';
import { workspaceRatchetService } from '@/backend/services/workspace';
import { SessionStatus } from '@/shared/core';
import type { RatchetSessionBridge } from './bridges';
import { type AcquireAndDispatchResult, fixerSessionService } from './fixer-session.service';
import type {
  PRStateInfo,
  RatchetAction,
  WorkspaceRatchetResult,
  WorkspaceWithPR,
} from './ratchet.types';

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
  await workspaceRatchetService.clearActiveSession(workspaceId, sessionId);
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
  onDispatchChanged?: (event: { workspaceId: string }) => void;
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
    onDispatchChanged,
  } = params;
  signal?.throwIfAborted();
  const promptSent = result.promptSent ?? true;
  if (!promptSent) {
    logger.warn('Ratchet session started but prompt delivery failed', {
      workspaceId: workspace.id,
      sessionId: result.sessionId,
    });
    signal?.throwIfAborted();
    await workspaceRatchetService.clearActiveSession(workspace.id, result.sessionId);
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
  const recorded = await workspaceRatchetService.recordDispatchIfEnabled(workspace.id, {
    sessionId: result.sessionId,
    prId: workspace.prId,
    snapshotKey: prStateInfo.snapshotKey,
    retryCount,
    requireExistingOwnership: true,
  });
  if (recorded) {
    onRecorded();
    onDispatchChanged?.({ workspaceId: workspace.id });
    if (result.promptCompletion !== undefined) {
      void settleFailedPromptCompletion({
        workspaceId: workspace.id,
        sessionId: result.sessionId,
        promptCompletion: result.promptCompletion,
        sessionBridge,
        onDispatchChanged,
      });
    }
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

async function settleFailedPromptCompletion(params: {
  workspaceId: string;
  sessionId: string;
  promptCompletion: Promise<boolean>;
  sessionBridge: RatchetSessionBridge;
  onDispatchChanged?: (event: { workspaceId: string }) => void;
}): Promise<void> {
  const { workspaceId, sessionId, promptCompletion, sessionBridge, onDispatchChanged } = params;

  try {
    const completed = await promptCompletion;
    if (completed) {
      return;
    }

    const settled = await workspaceRatchetService.recordSessionEnd(workspaceId, sessionId, 'DIED');
    if (!settled) {
      return;
    }
    onDispatchChanged?.({ workspaceId });
    if (sessionBridge.isSessionRunning(sessionId)) {
      await sessionBridge.stopSession(sessionId);
    }
  } catch (error) {
    logger.warn('Failed to reconcile ratchet prompt completion', {
      workspaceId,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleAlreadyActiveFixerResult(params: {
  workspace: WorkspaceWithPR;
  result: Extract<AcquireAndDispatchResult, { status: 'already_active' }>;
  sessionBridge: RatchetSessionBridge;
  signal?: AbortSignal;
  commitSideEffects: () => void;
  onDispatchChanged?: (event: { workspaceId: string }) => void;
}): Promise<RatchetAction> {
  const { workspace, result, sessionBridge, signal, commitSideEffects, onDispatchChanged } = params;
  // Adopt (pointer + RUNNING outcome) rather than record a full dispatch: the
  // session is working on an earlier prompt, so the current snapshot key must
  // not be marked as dispatched.
  signal?.throwIfAborted();
  commitSideEffects();
  const adopted = await workspaceRatchetService.adoptActiveSessionIfEnabled(
    workspace.id,
    result.sessionId,
    workspace.prId
  );
  if (adopted) {
    onDispatchChanged?.({ workspaceId: workspace.id });
  }
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
  outcome?: 'COMPLETED' | 'DIED';
}): Promise<void> {
  const { workspaceId, sessionId, sessionBridge } = params;
  try {
    await workspaceRatchetService.recordSessionEnd(
      workspaceId,
      sessionId,
      params.outcome ?? 'COMPLETED'
    );
  } catch (error) {
    logger.warn('Failed to settle unrecorded ratchet fixer during cleanup', {
      workspaceId,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    // stopSession finalizes transient ratchet sessions even without a runtime.
    await sessionBridge.stopSession(sessionId);
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
  onDispatchChanged?: (event: { workspaceId: string }) => void;
}): Promise<RatchetAction> {
  const {
    workspace,
    prStateInfo,
    retryCount,
    sessionBridge,
    signal,
    onDispatchChanged,
    commitSideEffects = () => {
      // Direct helper callers do not have a coordinator timeout to disable.
    },
  } = params;
  let result: AcquireAndDispatchResult | undefined;
  let startedFixerRecorded = false;
  let startedFixerCleaned = false;
  let acquiredSessionId: string | undefined;

  try {
    signal?.throwIfAborted();
    const userSettings = await userSettingsService.get();
    signal?.throwIfAborted();
    result = await fixerSessionService.acquireAndDispatch({
      workspaceId: workspace.id,
      workflow: RATCHET_WORKFLOW,
      workspacePrId: workspace.prId,
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
            headRefName: workspace.prHeadRefName,
            replyToPrComments: userSettings.ratchetReplyToPrComments,
          }
        ),
      beforeStart: ({ sessionId, prompt }) => {
        acquiredSessionId = sessionId;
        signal?.throwIfAborted();
        return workspaceRatchetService
          .recordDispatchIfEnabled(workspace.id, {
            prId: workspace.prId,
            expectedRevision: workspace.prRevision,
            sessionId,
            snapshotKey: prStateInfo.snapshotKey,
            retryCount,
          })
          .then((claimed) => {
            if (!claimed) {
              throw new Error('Workspace fixer slot no longer available');
            }
            sessionBridge.injectCommittedUserMessage(sessionId, prompt);
          });
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
        onDispatchChanged,
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
        onDispatchChanged,
      });
    }

    if (acquiredSessionId) {
      await cleanUpUnrecordedStartedFixer({
        workspaceId: workspace.id,
        sessionId: acquiredSessionId,
        sessionBridge,
        outcome: 'DIED',
      });
      acquiredSessionId = undefined;
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
    if (acquiredSessionId && !startedFixerCleaned) {
      await cleanUpUnrecordedStartedFixer({
        workspaceId: workspace.id,
        sessionId: acquiredSessionId,
        sessionBridge,
        outcome: 'DIED',
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

export async function stopActiveRatchetSessionsForTerminalPr(
  sessionBridge: RatchetSessionBridge,
  workspace: WorkspaceWithPR,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted();
  const sessions = await sessionBridge.findSessionsByWorkspaceId(workspace.id);
  signal.throwIfAborted();
  const activeRatchetSessions = sessions.filter(
    (session) =>
      session.workflow === 'ratchet' &&
      (session.workspacePrId === workspace.prId ||
        (workspace.ratchetActivePrId === workspace.prId &&
          session.id === workspace.ratchetActiveSessionId)) &&
      (session.status === SessionStatus.RUNNING || session.status === SessionStatus.IDLE)
  );

  for (const session of activeRatchetSessions) {
    signal.throwIfAborted();
    if (!sessionBridge.isSessionRunning(session.id)) {
      continue;
    }
    await sessionBridge.stopSession(session.id);
    signal.throwIfAborted();
  }
  if (workspace.ratchetActivePrId === workspace.prId && workspace.ratchetActiveSessionId) {
    await workspaceRatchetService.recordSessionEnd(
      workspace.id,
      workspace.ratchetActiveSessionId,
      'COMPLETED'
    );
  }
}

export async function cleanupCachedTerminalOwner(
  sessionBridge: RatchetSessionBridge,
  workspace: WorkspaceWithPR,
  signal: AbortSignal
): Promise<WorkspaceRatchetResult | null> {
  if (
    workspace.ratchetActivePrId !== workspace.prId ||
    !workspace.ratchetActiveSessionId ||
    (workspace.prState !== 'MERGED' && workspace.prState !== 'CLOSED')
  ) {
    return null;
  }
  await stopActiveRatchetSessionsForTerminalPr(sessionBridge, workspace, signal);
  return {
    workspaceId: workspace.id,
    prId: workspace.prId,
    previousState: workspace.ratchetState,
    newState: workspace.prState === 'MERGED' ? 'MERGED' : 'IDLE',
    action: { type: 'COMPLETED' },
  };
}
