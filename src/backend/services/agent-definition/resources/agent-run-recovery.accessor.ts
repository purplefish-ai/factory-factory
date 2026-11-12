import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { agentRunResultSchema } from '@/shared/agent-runtime';
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
import {
  childHeldOutcome,
  eventChildRestProof,
  eventChildRestSchema,
  isChildAtRest,
  type EventChildRest,
} from '@/shared/event-child-rest';
import type { Prisma } from '@prisma-gen/client';
import { currentLaunch, launchConflict, launchSnapshot } from './agent-launch.accessor';
import { ledgerTransaction } from './agent-ledger-transaction';
import {
  assertAttempt,
  childHoldDeadline,
  childObservationIsCurrent,
  hasStoppedRunWork,
} from './agent-run-settlement.accessor';

type Run = Awaited<ReturnType<typeof currentLaunch>>;
/** Orchestration's child observation plus whether the run's own work was idle before any stop. */
export type RecoveryChildObservation = { rest: EventChildRest; ownWorkIdle: boolean };
function assertStoppedWork(evidence: InitialDeliveryEvidence, proof: EventWorkProof) {
  if (!hasStoppedRunWork(evidence, proof)) {
    launchConflict();
  }
}
function assertContext(run: Run, input: EventRunRecoveryContext) {
  if (run.agentDefinition.projectId !== input.projectId) {
    launchConflict();
  }
  assertAttempt(run, input.attempt);
}
function blockedReason(run: Run) {
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
function childHold(run: Run, rest: EventChildRest) {
  if (rest.atRest) {
    return null;
  }
  const held = rest.children.filter((child) => !isChildAtRest(child.state));
  const evidence =
    run.initialDelivery.evidence === null
      ? null
      : initialDeliveryEvidenceSchema.parse(run.initialDelivery.evidence);
  return {
    children: held.slice(0, 20),
    heldCount: held.length,
    deadlineAt: evidence ? (childHoldDeadline(run, evidence)?.toISOString() ?? null) : null,
  };
}
function abandonment(
  run: Run,
  evidence: InitialDeliveryEvidence,
  children: RecoveryChildObservation
) {
  const own = evidence.outcome?.result;
  if (children.rest.atRest) {
    return {
      status: own === 'FAILED' ? 'FAILED' : 'CANCELLED',
      reasonCode: 'EXPLICIT_ABANDONMENT',
    } as const;
  }
  // Held only by children: a completed or failed initial turn keeps its own outcome.
  const result = run.result === null ? null : agentRunResultSchema.parse(run.result);
  const kept = children.ownWorkIdle
    ? childHeldOutcome(own, result?.pullRequests.length ?? 0)
    : null;
  return {
    status: kept ?? (own === 'FAILED' ? 'FAILED' : 'CANCELLED'),
    reasonCode: 'ABANDONED_WITH_CHILD_WORK',
  } as const;
}
async function writeAbandonment(
  tx: Prisma.TransactionClient,
  run: Run,
  evidence: InitialDeliveryEvidence,
  children: RecoveryChildObservation
) {
  await tx.agentInitialDelivery.update({
    where: { runId: run.id },
    data: { evidence: { ...evidence, children: eventChildRestProof(children.rest) } },
  });
  const { status, reasonCode } = abandonment(run, evidence, children);
  await tx.agentRun.update({
    where: { id: run.id },
    data: {
      status,
      launchPhase: 'FINISHED',
      completedAt: new Date(),
      leaseExpiresAt: null,
      nextAttemptAt: null,
      reasonCode,
    },
  });
}
/** Common, child and retry-resource blocks, in that order. */
async function actionBlock(
  tx: Prisma.TransactionClient,
  run: Run,
  context: EventRunRecoveryInput,
  rest: EventChildRest
) {
  const blocked = blockedReason(run);
  if (blocked) {
    return blocked;
  }
  // Only ABANDON may end a run whose children are not (provably) at rest.
  if (
    !(await childObservationIsCurrent(tx, context.claim.reservedWorkspaceId, rest)) ||
    (!rest.atRest && context.action !== 'ABANDON')
  ) {
    return 'CHILD_WORK_UNPROVEN' as const;
  }
  if (context.action === 'RETRY' && !(await retryResources(tx, run))) {
    return 'RESOURCES_UNAVAILABLE' as const;
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
  /** Without a child observation (scope checks only), `childHold` is not evaluated. */
  inspect(input: EventRunRecoveryContext, children: EventChildRest | null = null) {
    const rest = children === null ? null : eventChildRestSchema.parse(children);
    const context = eventRunRecoveryContextSchema.parse({
      projectId: input.projectId,
      claim: input.claim,
      attempt: input.attempt,
    });
    return ledgerTransaction(async (tx) => {
      const run = await currentLaunch(tx, context.claim, 'ANY');
      assertContext(run, context);
      if (rest && !(await childObservationIsCurrent(tx, context.claim.reservedWorkspaceId, rest))) {
        launchConflict();
      }
      return {
        run: launchSnapshot(run),
        blocked: blockedReason(run),
        childHold: rest ? childHold(run, rest) : null,
        retryResourcesAvailable: await retryResources(tx, run),
      };
    });
  },
  resolve(
    input: EventRunRecoveryInput,
    work: EventWorkProof,
    observedChildren: RecoveryChildObservation,
    assertCurrent: () => void
  ) {
    const context = eventRunRecoveryInputSchema.parse(input);
    const proof = eventWorkProofSchema.parse(work);
    const children = {
      rest: eventChildRestSchema.parse(observedChildren.rest),
      ownWorkIdle: observedChildren.ownWorkIdle,
    };
    assertCurrent();
    return ledgerTransaction(async (tx) => {
      const run = await currentLaunch(tx, context.claim);
      assertContext(run, context);
      const blocked = await actionBlock(tx, run, context, children.rest);
      if (blocked) {
        return { status: 'BLOCKED' as const, reason: blocked };
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
      if (context.action === 'ABANDON') {
        await writeAbandonment(tx, run, { ...evidence, work: proof, resolution }, children);
      } else {
        await tx.agentInitialDelivery.update({
          where: { runId: run.id },
          data: { evidence: { ...evidence, work: proof, resolution } },
        });
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
