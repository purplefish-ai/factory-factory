import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  initialDeliveryEvidenceSchema,
  eventRunResolutionSchema,
  type InitialDeliveryEvidence,
} from '@/shared/event-agent-delivery';
import {
  eventRunRecoveryContextSchema,
  eventRunRecoveryInputSchema,
  type EventRunRecoveryContext,
  type EventRunRecoveryInput,
} from '@/shared/event-agent-recovery';
import { eventWorkProofSchema, type EventWorkProof } from '@/shared/event-agent-work';
import type { Prisma } from '@prisma-gen/client';
import { currentLaunch, launchConflict, launchSnapshot } from './agent-launch.accessor';
import { ledgerTransaction } from './agent-ledger-transaction';
import { assertAttempt, childHistoryIsClear } from './agent-run-settlement.accessor';

type Run = Awaited<ReturnType<typeof currentLaunch>>;
function assertStoppedWork(evidence: InitialDeliveryEvidence, proof: EventWorkProof) {
  if (
    proof.mode !== 'STOPPED' ||
    evidence.stop?.status !== 'LOCAL_RUNTIME_GROUP_STOPPED' ||
    !isDeepStrictEqual(evidence.source, proof.source) ||
    !isDeepStrictEqual(evidence.stop.source, proof.source)
  ) {
    launchConflict();
  }
}
function assertContext(run: Run, input: EventRunRecoveryContext) {
  if (run.agentDefinition.projectId !== input.projectId) {
    launchConflict();
  }
  assertAttempt(run, input.attempt);
}
async function blockedReason(tx: Prisma.TransactionClient, run: Run) {
  if (!(await childHistoryIsClear(tx, run))) {
    return 'CHILD_WORK_UNPROVEN' as const;
  }
  const snapshot = launchSnapshot(run);
  if (
    snapshot.delivery.state === 'PENDING' &&
    snapshot.preparation &&
    snapshot.preparation.state !== 'SAFE'
  ) {
    return 'PREPARATION_CLEANUP_UNCERTAIN' as const;
  }
  return null;
}
async function retryResources(tx: Prisma.TransactionClient, run: Run) {
  if (!(run.reservedWorkspaceId && run.reservedSessionId)) {
    return false;
  }
  const workspace = await tx.workspace.findUnique({
    where: { id: run.reservedWorkspaceId },
    include: { project: true },
  });
  const session = await tx.agentSession.findUnique({ where: { id: run.reservedSessionId } });
  const origin = await tx.agentSessionLaunchOrigin.findUnique({ where: { runId: run.id } });
  const execution = launchSnapshot(run).effectiveExecution;
  if (
    !(workspace && session && origin && execution) ||
    workspace.project.isArchived ||
    workspace.status !== 'READY' ||
    !workspace.worktreePath ||
    workspace.projectId !== run.agentDefinition.projectId ||
    run.workspaceId !== workspace.id ||
    session.workspaceId !== workspace.id ||
    origin.sessionId !== session.id ||
    origin.workspaceId !== workspace.id ||
    !isDeepStrictEqual(origin.execution, run.effectiveExecution) ||
    session.codexAccountId !== execution.codexAccountId ||
    session.provider !== execution.provider
  ) {
    return false;
  }
  return (
    !execution.codexAccountId ||
    !!(await tx.codexAccount.findFirst({ where: { id: execution.codexAccountId, enabled: true } }))
  );
}
export const agentRunRecoveryAccessor = {
  inspect(input: EventRunRecoveryContext) {
    const context = eventRunRecoveryContextSchema.parse({
      projectId: input.projectId,
      claim: input.claim,
      attempt: input.attempt,
    });
    return ledgerTransaction(async (tx) => {
      const run = await currentLaunch(tx, context.claim, 'ANY');
      assertContext(run, context);
      return {
        run: launchSnapshot(run),
        blocked: await blockedReason(tx, run),
        retryResourcesAvailable: await retryResources(tx, run),
      };
    });
  },
  resolve(input: EventRunRecoveryInput, work: EventWorkProof, assertCurrent: () => void) {
    const context = eventRunRecoveryInputSchema.parse(input);
    const proof = eventWorkProofSchema.parse(work);
    assertCurrent();
    return ledgerTransaction(async (tx) => {
      const run = await currentLaunch(tx, context.claim);
      assertContext(run, context);
      const blocked = await blockedReason(tx, run);
      if (blocked) {
        return { status: 'BLOCKED' as const, reason: blocked };
      }
      if (context.action === 'RETRY' && !(await retryResources(tx, run))) {
        return { status: 'BLOCKED' as const, reason: 'RESOURCES_UNAVAILABLE' as const };
      }
      const evidence = initialDeliveryEvidenceSchema.parse(run.initialDelivery.evidence);
      assertStoppedWork(evidence, proof);
      const resolution = eventRunResolutionSchema.parse({
        action: context.action,
        attempt: context.attempt,
        outcome: evidence.outcome,
        stop: evidence.stop,
        work: proof,
        resolvedAt: new Date().toISOString(),
      });
      if (context.action === 'RETRY') {
        const attempt = {
          ...context.attempt,
          attemptGeneration: context.attempt.attemptGeneration + 1,
          messageId: randomUUID(),
          sendAttemptId: randomUUID(),
        };
        await tx.agentInitialDelivery.update({
          where: { runId: run.id },
          data: {
            state: 'PENDING',
            attemptGeneration: attempt.attemptGeneration,
            messageId: attempt.messageId,
            sendAttemptId: attempt.sendAttemptId,
            providerTurnId: null,
            sendingAt: null,
            acceptedAt: null,
            finishedAt: null,
            evidence: { version: 1, attempt, resolution },
          },
        });
        const preparation = launchSnapshot(run).preparation;
        await tx.agentRun.update({
          where: { id: run.id },
          data: {
            attemptGeneration: attempt.attemptGeneration,
            launchPhase: 'READY',
            nextAttemptAt: null,
            reasonCode: null,
            launchPreparation: {
              version: 1,
              state: 'SAFE',
              setupStartedAt: preparation?.setupStartedAt ?? null,
            },
          },
        });
        assertCurrent();
        return {
          status: 'RETRIED' as const,
          claim: { ...context.claim, attemptGeneration: attempt.attemptGeneration },
          attempt,
        };
      }
      await tx.agentInitialDelivery.update({
        where: { runId: run.id },
        data: { evidence: { ...evidence, work: proof, resolution } },
      });
      if (context.action === 'ABANDON') {
        await tx.agentRun.update({
          where: { id: run.id },
          data: {
            status: evidence.outcome?.result === 'FAILED' ? 'FAILED' : 'CANCELLED',
            launchPhase: 'FINISHED',
            completedAt: new Date(),
            leaseExpiresAt: null,
            nextAttemptAt: null,
            reasonCode: 'EXPLICIT_ABANDONMENT',
          },
        });
      } else {
        await tx.agentRun.update({
          where: { id: run.id },
          data: { launchPhase: 'NEEDS_ATTENTION', reasonCode: 'EXPLICITLY_RESOLVED' },
        });
      }
      // Same final synchronous proof check as settlement; engine COMMIT remains a gap.
      assertCurrent();
      return {
        status: context.action === 'ABANDON' ? ('ABANDONED' as const) : ('RESOLVED' as const),
      };
    });
  },
};
