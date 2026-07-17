import type { RatchetDispatchOutcome, SessionProvider } from '@prisma-gen/client';
import { createLogger } from '@/backend/services/logger.service';
import { SessionStatus } from '@/shared/core';
import type { RatchetSessionBridge, RatchetWorkspaceBridge } from './bridges';
import type { ActiveFixerCheckResult, WorkspaceWithPR } from './ratchet.types';
import { ratchetProviderResolverService } from './ratchet-provider-resolver.service';

const logger = createLogger('ratchet');

async function safeStopSession(params: {
  sessionBridge: RatchetSessionBridge;
  sessionId: string;
  warningMessage: string;
  warningContext: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<void> {
  const { sessionBridge, sessionId, warningMessage, warningContext, signal } = params;
  try {
    signal?.throwIfAborted();
    await sessionBridge.stopSession(sessionId);
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
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
  signal?: AbortSignal;
}): Promise<void> {
  await safeStopSession({
    sessionBridge: params.sessionBridge,
    sessionId: params.sessionId,
    warningMessage: 'Failed to stop completed ratchet session',
    warningContext: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
    },
    signal: params.signal,
  });
}

async function stopSessionForProviderMismatch(params: {
  workspaceId: string;
  sessionId: string;
  expectedProvider: SessionProvider;
  actualProvider: SessionProvider;
  sessionBridge: RatchetSessionBridge;
  signal?: AbortSignal;
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
    signal: params.signal,
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
  workspaceBridge: Pick<RatchetWorkspaceBridge, 'recordSessionEnd'>;
  signal?: AbortSignal;
}): Promise<ActiveFixerCheckResult> {
  const { workspace, sessionBridge, workspaceBridge, signal } = params;
  signal?.throwIfAborted();

  const sessionId = workspace.ratchetActiveSessionId;
  if (!sessionId) {
    return { kind: 'none' };
  }

  const settle = async (
    outcome: Exclude<RatchetDispatchOutcome, 'RUNNING'>,
    reason: string
  ): Promise<ActiveFixerCheckResult> => {
    signal?.throwIfAborted();
    const settled = await workspaceBridge.recordSessionEnd(workspace.id, sessionId, outcome);
    signal?.throwIfAborted();
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

  signal?.throwIfAborted();
  const resolvedRatchetProvider = await ratchetProviderResolverService.resolveRatchetProvider({
    workspaceId: workspace.id,
    workspace,
  });
  signal?.throwIfAborted();
  const session = await sessionBridge.findSessionById(sessionId);
  signal?.throwIfAborted();
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
      signal,
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
      signal,
    });
    return result;
  }

  return { kind: 'active', action: { type: 'FIXER_ACTIVE', sessionId } };
}

export async function hasActiveSession(
  workspaceId: string,
  sessionBridge: RatchetSessionBridge,
  signal?: AbortSignal
): Promise<boolean> {
  signal?.throwIfAborted();
  const sessions = await sessionBridge.findSessionsByWorkspaceId(workspaceId);
  signal?.throwIfAborted();
  return sessions.some((session) => sessionBridge.isSessionWorking(session.id));
}
