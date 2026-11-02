import { isDeepStrictEqual } from 'node:util';
import { ApplicationError } from '@/backend/lib/application-error';
import { agentClaimResultSchema, agentResolvedExecutionConfigSchema } from '@/shared/agent-runtime';
import { initialAttemptSchema, initialDeliveryEvidenceSchema } from '@/shared/event-agent-delivery';
import { eventAgentExecutionSchema } from '@/shared/event-agent-launch';
import {
  eventLaunchPreparationSchema,
  type EventLaunchPreparation,
} from '@/shared/event-agent-preparation';
import {
  agentDefinitionInputSchema,
  agentRunInputSchema,
  agentTriggerInputSchema,
} from '@/shared/schemas/agent-definition.schema';
import type { Prisma } from '@prisma-gen/client';
import type { EventLaunchClaim } from './agent-execution-binding.accessor';
import { ledgerTransaction } from './agent-ledger-transaction';

export function launchConflict(): never {
  throw new ApplicationError('CONFLICT', 'Event launch ownership is no longer current');
}
export async function currentLaunch(
  tx: Prisma.TransactionClient,
  input: EventLaunchClaim,
  lease: 'LIVE' | 'EXPIRED' | 'ANY' = 'LIVE'
) {
  const claim = agentClaimResultSchema.options[0].parse(input);
  const run = await tx.agentRun.findUnique({
    where: { id: claim.runId },
    include: { initialDelivery: true, agentDefinition: { select: { projectId: true } } },
  });
  if (
    run?.status !== 'RUNNING' ||
    run.workerGeneration !== claim.workerGeneration ||
    run.attemptGeneration !== claim.attemptGeneration ||
    run.reservedWorkspaceId !== claim.reservedWorkspaceId ||
    run.reservedSessionId !== claim.reservedSessionId ||
    run.initialMessageId !== claim.initialMessageId ||
    (lease === 'LIVE'
      ? !run.leaseExpiresAt || run.leaseExpiresAt <= new Date()
      : lease === 'EXPIRED' && run.leaseExpiresAt && run.leaseExpiresAt > new Date()) ||
    run.initialDelivery?.attemptGeneration !== claim.attemptGeneration
  ) {
    launchConflict();
  }
  if (!run.initialDelivery) {
    launchConflict();
  }
  return { ...run, initialDelivery: run.initialDelivery };
}
export function launchSnapshot(run: Awaited<ReturnType<typeof currentLaunch>>) {
  const definition = agentDefinitionInputSchema.parse(run.definitionSnapshot);
  const execution = agentResolvedExecutionConfigSchema.parse(definition.executionConfig);
  const input = agentRunInputSchema.parse(run.input);
  if (run.eventId !== null && input.eventId !== run.eventId) {
    launchConflict();
  }
  const attempt = initialAttemptSchema.parse({
    runId: run.id,
    sessionId: run.reservedSessionId,
    workerGeneration: run.workerGeneration,
    attemptGeneration: run.attemptGeneration,
    messageId: run.initialDelivery.messageId,
    sendAttemptId: run.initialDelivery.sendAttemptId,
  });
  const evidence =
    run.initialDelivery.evidence === null
      ? null
      : initialDeliveryEvidenceSchema.parse(run.initialDelivery.evidence);
  if (
    run.initialDelivery.attemptGeneration !== run.attemptGeneration ||
    (evidence &&
      !isDeepStrictEqual({ ...evidence.attempt, workerGeneration: run.workerGeneration }, attempt))
  ) {
    launchConflict();
  }
  return {
    claim: agentClaimResultSchema.options[0].parse({
      status: 'CLAIMED',
      runId: run.id,
      workerGeneration: run.workerGeneration,
      attemptGeneration: run.attemptGeneration,
      reservedWorkspaceId: run.reservedWorkspaceId,
      reservedSessionId: run.reservedSessionId,
      initialMessageId: run.initialMessageId,
    }),
    projectId: run.agentDefinition.projectId,
    definition,
    trigger: agentTriggerInputSchema.parse(run.triggerSnapshot),
    reasonCode: run.reasonCode,
    input,
    execution,
    effectiveExecution:
      run.effectiveExecution === null
        ? null
        : eventAgentExecutionSchema.parse(run.effectiveExecution),
    preparation:
      run.launchPreparation === null
        ? null
        : eventLaunchPreparationSchema.parse(run.launchPreparation),
    delivery: {
      ...run.initialDelivery,
      evidence,
    },
    workspaceId: run.workspaceId,
    phase: run.launchPhase,
    attemptCount: run.attemptCount,
    nextAttemptAt: run.nextAttemptAt,
    startedAt: run.startedAt,
    leaseExpiresAt: run.leaseExpiresAt,
  };
}
export const agentLaunchAccessor = {
  read: (claim: EventLaunchClaim) =>
    ledgerTransaction(async (tx) => launchSnapshot(await currentLaunch(tx, claim))),
  link: (claim: EventLaunchClaim) =>
    ledgerTransaction(async (tx) => {
      const run = await currentLaunch(tx, claim);
      if (
        run.initialDelivery.state !== 'PENDING' ||
        !['PROVISIONING', 'READY'].includes(run.launchPhase)
      ) {
        launchConflict();
      }
      const workspace = await tx.workspace.findUnique({
        where: { id: claim.reservedWorkspaceId },
        include: { project: true },
      });
      const origin = await tx.workspaceLaunchOrigin.findUnique({ where: { runId: claim.runId } });
      const session = await tx.agentSession.findUnique({ where: { id: claim.reservedSessionId } });
      const sessionOrigin = await tx.agentSessionLaunchOrigin.findUnique({
        where: { runId: claim.runId },
      });
      if (
        !(workspace && origin && session && sessionOrigin) ||
        workspace.project.isArchived ||
        ['ARCHIVING', 'ARCHIVED'].includes(workspace.status) ||
        workspace.projectId !== run.agentDefinition.projectId ||
        workspace.creationSource !== 'EVENT_AGENT' ||
        origin.workspaceId !== workspace.id ||
        origin.projectId !== workspace.projectId ||
        session.workspaceId !== workspace.id ||
        sessionOrigin.workspaceId !== workspace.id ||
        sessionOrigin.sessionId !== session.id ||
        !isDeepStrictEqual(sessionOrigin.execution, run.effectiveExecution) ||
        (run.workspaceId && run.workspaceId !== workspace.id)
      ) {
        launchConflict();
      }
      await tx.agentRun.update({ where: { id: run.id }, data: { workspaceId: workspace.id } });
    }),
  preparation: (claim: EventLaunchClaim, state: EventLaunchPreparation['state']) =>
    ledgerTransaction(async (tx) => {
      const run = await currentLaunch(tx, claim);
      if (
        run.initialDelivery.state !== 'PENDING' ||
        !['PROVISIONING', 'READY'].includes(run.launchPhase)
      ) {
        launchConflict();
      }
      const previous =
        run.launchPreparation === null
          ? null
          : eventLaunchPreparationSchema.parse(run.launchPreparation);
      if ((state === 'SETUP' || state === 'STARTUP') && previous && previous.state !== 'SAFE') {
        launchConflict();
      }
      const preparation = eventLaunchPreparationSchema.parse({
        version: 1,
        state,
        setupStartedAt:
          previous?.setupStartedAt ?? (state === 'SETUP' ? new Date().toISOString() : null),
      });
      await tx.agentRun.update({
        where: { id: run.id },
        data: {
          launchPreparation: preparation,
          ...(state === 'STARTUP' ? { launchPhase: 'READY' } : {}),
        },
      });
      return preparation;
    }),
};
