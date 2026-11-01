import { isDeepStrictEqual } from 'node:util';
import { prisma } from '@/backend/db';
import { ApplicationError } from '@/backend/lib/application-error';
import {
  initialAttemptSchema,
  initialDeliveryEvidenceSchema,
  initialDeliveryFenceSchema,
  initialOutcomeSchema,
  providerSourceSchema,
  runtimeStopEvidenceSchema,
  type InitialAttempt,
  type InitialDeliveryEvidence,
  type InitialDeliveryOwnerPort,
} from '@/shared/event-agent-delivery';
import type { Prisma } from '@prisma-gen/client';
import { ledgerTransaction } from './agent-ledger-transaction';

function conflict(): never {
  throw new ApplicationError(
    'CONFLICT',
    'Initial delivery ownership or evidence is no longer current'
  );
}
async function current(tx: Prisma.TransactionClient, attempt: InitialAttempt) {
  const run = await tx.agentRun.findUnique({
    where: { id: attempt.runId },
    include: { initialDelivery: true },
  });
  const delivery = run?.initialDelivery;
  if (
    !(run && delivery) ||
    run.workerGeneration !== attempt.workerGeneration ||
    run.attemptGeneration !== attempt.attemptGeneration ||
    run.reservedSessionId !== attempt.sessionId ||
    delivery.attemptGeneration !== attempt.attemptGeneration ||
    delivery.messageId !== attempt.messageId ||
    delivery.sendAttemptId !== attempt.sendAttemptId
  ) {
    conflict();
  }
  const evidence: InitialDeliveryEvidence =
    delivery.evidence === null
      ? { version: 1, attempt }
      : initialDeliveryEvidenceSchema.parse(delivery.evidence);
  if (
    !isDeepStrictEqual({ ...evidence.attempt, workerGeneration: attempt.workerGeneration }, attempt)
  ) {
    conflict();
  }
  return { run, delivery, evidence };
}
export const agentPromptAccessor: InitialDeliveryOwnerPort = {
  async readFence(runId, sessionId) {
    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      include: { initialDelivery: true },
    });
    const delivery = run?.initialDelivery;
    if (
      !(run && delivery) ||
      run.reservedSessionId !== sessionId ||
      delivery.attemptGeneration !== run.attemptGeneration
    ) {
      conflict();
    }
    return initialDeliveryFenceSchema.parse({
      attempt: {
        runId,
        sessionId,
        workerGeneration: run.workerGeneration,
        attemptGeneration: run.attemptGeneration,
        messageId: delivery.messageId,
        sendAttemptId: delivery.sendAttemptId,
      },
      state: delivery.state,
      execution: run.effectiveExecution,
      evidence: delivery.evidence,
    });
  },
  async beforeSend(input, sourceInput) {
    const attempt = initialAttemptSchema.parse(input);
    const source = providerSourceSchema.parse(sourceInput);
    await ledgerTransaction(async (tx) => {
      const { run, delivery, evidence } = await current(tx, attempt);
      if (
        run.status !== 'RUNNING' ||
        !['PROVISIONING', 'READY'].includes(run.launchPhase) ||
        !run.leaseExpiresAt ||
        run.leaseExpiresAt <= new Date() ||
        delivery.state !== 'PENDING'
      ) {
        conflict();
      }
      const fence = initialDeliveryFenceSchema.parse({
        attempt,
        state: delivery.state,
        execution: run.effectiveExecution,
        evidence: null,
      });
      if (fence.execution.provider !== source.provider) {
        conflict();
      }
      await tx.agentInitialDelivery.update({
        where: { runId: run.id },
        data: { state: 'SENDING', sendingAt: new Date(), evidence: { ...evidence, source } },
      });
      await tx.agentRun.update({ where: { id: run.id }, data: { launchPhase: 'DISPATCHING' } });
    });
  },
  async outcome(input, outcomeInput) {
    const attempt = initialAttemptSchema.parse(input);
    const outcome = initialOutcomeSchema.parse(outcomeInput);
    await ledgerTransaction(async (tx) => {
      const { run, delivery, evidence } = await current(tx, attempt);
      if (!isDeepStrictEqual(evidence.source, outcome.source)) {
        conflict();
      }
      if (evidence.outcome) {
        if (!isDeepStrictEqual(evidence.outcome, outcome)) {
          conflict();
        }
        return;
      }
      if (
        !['SENDING', 'ACCEPTED', 'AMBIGUOUS'].includes(delivery.state) ||
        run.status !== 'RUNNING'
      ) {
        conflict();
      }
      await tx.agentInitialDelivery.update({
        where: { runId: run.id },
        data: { state: 'FINISHED', finishedAt: new Date(), evidence: { ...evidence, outcome } },
      });
      // Task5 settles only after authoritative owned-work quiescence; outcome alone releases no capacity.
      await tx.agentRun.update({ where: { id: run.id }, data: { launchPhase: 'ACTIVE' } });
    });
  },
  async ambiguous(input) {
    const attempt = initialAttemptSchema.parse(input);
    await ledgerTransaction(async (tx) => {
      const { run, delivery } = await current(tx, attempt);
      if (delivery.state === 'FINISHED') {
        return;
      }
      if (
        run.status !== 'RUNNING' ||
        !['SENDING', 'ACCEPTED', 'AMBIGUOUS'].includes(delivery.state)
      ) {
        conflict();
      }
      await tx.agentInitialDelivery.update({
        where: { runId: run.id },
        data: { state: 'AMBIGUOUS' },
      });
      await tx.agentRun.update({ where: { id: run.id }, data: { launchPhase: 'NEEDS_ATTENTION' } });
    });
  },
  async stop(input, stopInput) {
    const attempt = initialAttemptSchema.parse(input);
    const stop = runtimeStopEvidenceSchema.parse(stopInput);
    await ledgerTransaction(async (tx) => {
      const { run, delivery, evidence } = await current(tx, attempt);
      if (
        delivery.state !== 'FINISHED' &&
        stop.source &&
        evidence.source &&
        !isDeepStrictEqual(evidence.source, stop.source)
      ) {
        conflict();
      }
      await tx.agentInitialDelivery.update({
        where: { runId: run.id },
        data: { evidence: { ...evidence, stop } },
      });
      // Shutdown/system stop is never rewritten into a user-cancelled initial outcome.
    });
  },
};
