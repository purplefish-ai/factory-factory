import type { SessionProvider } from '@prisma-gen/client';
import { agentSessionAccessor } from '@/backend/resource_accessors/agent-session.accessor';
import type { createLogger } from '@/backend/services/logger.service';
import { SessionStatus } from '@/shared/core';
import type { RatchetPRSnapshotBridge, RatchetSessionBridge } from './bridges';
import type { RatchetAction, WorkspaceWithPR } from './ratchet.types';
import { ratchetProviderResolverService } from './ratchet-provider-resolver.service';

type Logger = ReturnType<typeof createLogger>;

async function clearFailedRatchetDispatch(params: {
  workspace: WorkspaceWithPR;
  snapshotBridge: RatchetPRSnapshotBridge;
  resetDispatchState: (workspaceId: string) => Promise<void>;
  reason: string;
  logger: Logger;
}): Promise<void> {
  const { workspace, snapshotBridge, resetDispatchState, reason, logger } = params;
  logger.info('Clearing failed ratchet dispatch, resetting state for retry', {
    workspaceId: workspace.id,
    sessionId: workspace.ratchetActiveSessionId,
    reason,
  });

  await resetDispatchState(workspace.id);
  await snapshotBridge.recordReviewCheck(workspace.id, null);
}

async function clearActiveRatchetSession(
  workspaceId: string,
  clearActiveSession: (workspaceId: string) => Promise<void>
): Promise<void> {
  await clearActiveSession(workspaceId);
}

async function safeStopSession(params: {
  sessionBridge: RatchetSessionBridge;
  sessionId: string;
  warningMessage: string;
  warningContext: Record<string, unknown>;
  logger: Logger;
}): Promise<void> {
  const { sessionBridge, sessionId, warningMessage, warningContext, logger } = params;
  try {
    await sessionBridge.stopSession(sessionId);
  } catch (error) {
    logger.warn(warningMessage, {
      ...warningContext,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function stopCompletedRatchetSession(params: {
  workspaceId: string;
  sessionId: string;
  sessionBridge: RatchetSessionBridge;
  logger: Logger;
}): Promise<void> {
  await safeStopSession({
    sessionBridge: params.sessionBridge,
    sessionId: params.sessionId,
    warningMessage: 'Failed to stop completed ratchet session',
    warningContext: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
    },
    logger: params.logger,
  });
}

async function stopSessionForProviderMismatch(params: {
  workspaceId: string;
  sessionId: string;
  expectedProvider: SessionProvider;
  actualProvider: SessionProvider;
  sessionBridge: RatchetSessionBridge;
  logger: Logger;
}): Promise<void> {
  await safeStopSession({
    sessionBridge: params.sessionBridge,
    sessionId: params.sessionId,
    warningMessage: 'Failed to stop mismatched ratchet provider session',
    warningContext: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      expectedProvider: params.expectedProvider,
      actualProvider: params.actualProvider,
    },
    logger: params.logger,
  });
}

export async function getActiveRatchetSession(params: {
  workspace: WorkspaceWithPR;
  sessionBridge: RatchetSessionBridge;
  snapshotBridge: RatchetPRSnapshotBridge;
  resetDispatchState: (workspaceId: string) => Promise<void>;
  clearActiveSession: (workspaceId: string) => Promise<void>;
  logger: Logger;
}): Promise<RatchetAction | null> {
  const {
    workspace,
    sessionBridge,
    snapshotBridge,
    resetDispatchState,
    clearActiveSession,
    logger,
  } = params;

  if (!workspace.ratchetActiveSessionId) {
    return null;
  }

  const resolvedRatchetProvider = await ratchetProviderResolverService.resolveRatchetProvider({
    workspaceId: workspace.id,
    workspace,
  });
  const session = await agentSessionAccessor.findById(workspace.ratchetActiveSessionId);
  if (!session) {
    await clearFailedRatchetDispatch({
      workspace,
      snapshotBridge,
      resetDispatchState,
      reason: 'session not found in database',
      logger,
    });
    return null;
  }

  if (session.provider !== resolvedRatchetProvider) {
    await clearFailedRatchetDispatch({
      workspace,
      snapshotBridge,
      resetDispatchState,
      reason: `provider mismatch: expected ${resolvedRatchetProvider}, got ${session.provider}`,
      logger,
    });
    await stopSessionForProviderMismatch({
      workspaceId: workspace.id,
      sessionId: session.id,
      expectedProvider: resolvedRatchetProvider,
      actualProvider: session.provider,
      sessionBridge,
      logger,
    });
    return null;
  }

  if (session.status !== SessionStatus.RUNNING) {
    await clearFailedRatchetDispatch({
      workspace,
      snapshotBridge,
      resetDispatchState,
      reason: `session status is ${session.status}`,
      logger,
    });
    return null;
  }

  if (!sessionBridge.isSessionRunning(session.id)) {
    await clearFailedRatchetDispatch({
      workspace,
      snapshotBridge,
      resetDispatchState,
      reason: 'session process is not running',
      logger,
    });
    return null;
  }

  // Ratchet session has completed its current unit of work: close it to avoid lingering idle agents.
  if (!sessionBridge.isSessionWorking(session.id)) {
    await clearActiveRatchetSession(workspace.id, clearActiveSession);
    await stopCompletedRatchetSession({
      workspaceId: workspace.id,
      sessionId: session.id,
      sessionBridge,
      logger,
    });
    return null;
  }

  return { type: 'FIXER_ACTIVE', sessionId: workspace.ratchetActiveSessionId };
}

export async function hasActiveSession(
  workspaceId: string,
  sessionBridge: RatchetSessionBridge
): Promise<boolean> {
  const sessions = await agentSessionAccessor.findByWorkspaceId(workspaceId);
  return sessions.some((session) => sessionBridge.isSessionWorking(session.id));
}
