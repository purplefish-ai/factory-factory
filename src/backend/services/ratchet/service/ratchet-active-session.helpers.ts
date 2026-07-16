import type { RatchetDispatchOutcome, SessionProvider } from '@prisma-gen/client';
import { createLogger } from '@/backend/services/logger.service';
import { agentSessionAccessor } from '@/backend/services/session';
import { workspaceAccessor } from '@/backend/services/workspace';
import { SessionStatus } from '@/shared/core';
import type { RatchetSessionBridge } from './bridges';
import type { ActiveFixerCheckResult, WorkspaceWithPR } from './ratchet.types';
import { ratchetProviderResolverService } from './ratchet-provider-resolver.service';

const logger = createLogger('ratchet');

async function safeStopSession(params: {
  sessionBridge: RatchetSessionBridge;
  sessionId: string;
  warningMessage: string;
  warningContext: Record<string, unknown>;
}): Promise<void> {
  const { sessionBridge, sessionId, warningMessage, warningContext } = params;
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
}): Promise<void> {
  await safeStopSession({
    sessionBridge: params.sessionBridge,
    sessionId: params.sessionId,
    warningMessage: 'Failed to stop completed ratchet session',
    warningContext: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
    },
  });
}

async function stopSessionForProviderMismatch(params: {
  workspaceId: string;
  sessionId: string;
  expectedProvider: SessionProvider;
  actualProvider: SessionProvider;
  sessionBridge: RatchetSessionBridge;
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
  });
}

/**
 * Verify the recorded fixer session pointer against the actual session, and
 * settle the dispatch record if the session has ended. Settling is conditional
 * on the pointer still naming the session (see recordSessionEnd), so if the
 * session ends normally while this check is in flight, the lifecycle hook wins
 * and this returns 'ended_concurrently' instead of misreporting a death.
 */
export async function checkActiveFixerSession(params: {
  workspace: WorkspaceWithPR;
  sessionBridge: RatchetSessionBridge;
}): Promise<ActiveFixerCheckResult> {
  const { workspace, sessionBridge } = params;

  const sessionId = workspace.ratchetActiveSessionId;
  if (!sessionId) {
    return { kind: 'none' };
  }

  const settle = async (
    outcome: Exclude<RatchetDispatchOutcome, 'RUNNING'>,
    reason: string
  ): Promise<ActiveFixerCheckResult> => {
    const settled = await workspaceAccessor.recordRatchetSessionEnd(
      workspace.id,
      sessionId,
      outcome
    );
    if (!settled) {
      logger.debug('Ratchet dispatch record was settled concurrently', {
        workspaceId: workspace.id,
        sessionId,
        reason,
      });
      return { kind: 'ended_concurrently' };
    }
    logger.info('Settled ratchet dispatch record for ended fixer session', {
      workspaceId: workspace.id,
      sessionId,
      outcome,
      reason,
    });
    return { kind: 'settled', outcome };
  };

  const resolvedRatchetProvider = await ratchetProviderResolverService.resolveRatchetProvider({
    workspaceId: workspace.id,
    workspace,
  });
  const session = await agentSessionAccessor.findById(sessionId);
  if (!session) {
    // Transient ratchet session rows are deleted on normal exit, so a missing
    // row is ambiguous — the conditional settle disambiguates: if the exit
    // hook already recorded an outcome, this no-ops ('ended_concurrently').
    return settle('DIED', 'session not found in database');
  }

  if (session.provider !== resolvedRatchetProvider) {
    const result = await settle(
      'DIED',
      `provider mismatch: expected ${resolvedRatchetProvider}, got ${session.provider}`
    );
    await stopSessionForProviderMismatch({
      workspaceId: workspace.id,
      sessionId: session.id,
      expectedProvider: resolvedRatchetProvider,
      actualProvider: session.provider,
      sessionBridge,
    });
    return result;
  }

  if (session.status !== SessionStatus.RUNNING) {
    return settle(
      session.status === SessionStatus.FAILED ? 'DIED' : 'COMPLETED',
      `session status is ${session.status}`
    );
  }

  if (!sessionBridge.isSessionRunning(session.id)) {
    return settle('DIED', 'session process is not running');
  }

  // Ratchet session has completed its current unit of work: settle first so
  // the stop's exit hook no-ops, then close it to avoid lingering idle agents.
  if (!sessionBridge.isSessionWorking(session.id)) {
    const result = await settle('COMPLETED', 'session finished its unit of work');
    await stopCompletedRatchetSession({
      workspaceId: workspace.id,
      sessionId: session.id,
      sessionBridge,
    });
    return result;
  }

  return { kind: 'active', action: { type: 'FIXER_ACTIVE', sessionId } };
}

export async function hasActiveSession(
  workspaceId: string,
  sessionBridge: RatchetSessionBridge
): Promise<boolean> {
  const sessions = await agentSessionAccessor.findByWorkspaceId(workspaceId);
  return sessions.some((session) => sessionBridge.isSessionWorking(session.id));
}
