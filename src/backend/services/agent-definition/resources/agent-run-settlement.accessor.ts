import { isDeepStrictEqual } from 'node:util';
import { configService } from '@/backend/services/config.service';
import { agentRunResultSchema } from '@/shared/agent-runtime';
import {
  initialAttemptSchema,
  initialDeliveryEvidenceSchema,
  type InitialAttempt,
  type InitialDeliveryEvidence,
} from '@/shared/event-agent-delivery';
import { eventWorkProofSchema, type EventWorkProof } from '@/shared/event-agent-work';
import {
  eventChildRestProof,
  eventChildRestSchema,
  type EventChildRest,
} from '@/shared/event-child-rest';
import type { Prisma } from '@prisma-gen/client';
import type { EventLaunchClaim } from './agent-execution-binding.accessor';
import { currentLaunch, launchConflict } from './agent-launch.accessor';
import { ledgerTransaction } from './agent-ledger-transaction';
import { mergeRunResults } from './agent-run-result';
import { writeRunSettlement } from './agent-run-settlement-writes';

type Result = ReturnType<typeof agentRunResultSchema.parse>;
type Run = Awaited<ReturnType<typeof currentLaunch>>;
function terminalResult(evidence: InitialDeliveryEvidence, unavailable: boolean) {
  if (evidence.outcome) {
    return evidence.outcome.result;
  }
  switch (evidence.stop?.cause) {
    case 'USER_STOP':
    case 'WORKSPACE_ARCHIVED':
      return 'CANCELLED';
    case 'TIMEOUT':
    case 'UNEXPECTED_EXIT':
      return 'FAILED';
    case 'SYSTEM_STOP':
      return unavailable ? 'CANCELLED' : null;
    default:
      return null;
  }
}
/** The existing conditions on the run's own initial turn, without child workspaces. */
async function ownSettlement(tx: Prisma.TransactionClient, run: Run, proof: EventWorkProof | null) {
  if (!proof || run.initialDelivery.evidence === null || run.reasonCode === 'EXPLICITLY_RESOLVED') {
    return null;
  }
  const evidence = initialDeliveryEvidenceSchema.parse(run.initialDelivery.evidence);
  if (
    !isDeepStrictEqual(proof.source, evidence.source) ||
    (evidence.outcome && !isDeepStrictEqual(evidence.outcome.source, proof.source))
  ) {
    launchConflict();
  }
  const workspaceId = run.reservedWorkspaceId;
  if (!workspaceId) {
    launchConflict();
  }
  const workspace = await tx.workspace.findUnique({
    where: { id: workspaceId },
    select: { status: true },
  });
  const unavailable =
    !workspace || workspace.status === 'ARCHIVED' || workspace.status === 'ARCHIVING';
  const terminal = terminalResult(evidence, unavailable);
  const stopped = hasStoppedRunWork(evidence, proof);
  if (!terminal || ((terminal !== 'COMPLETED' || unavailable) && !stopped)) {
    return null;
  }
  return { evidence, proof, terminal, workspaceId };
}
async function settlementFor(
  tx: Prisma.TransactionClient,
  run: Run,
  work: EventWorkProof | null,
  result: Result,
  children: EventChildRest
): Promise<{
  evidence: InitialDeliveryEvidence;
  proof: EventWorkProof;
  status: Parameters<typeof writeRunSettlement>[5];
  reasonCode: 'CHILD_HOLD_EXPIRED' | null;
} | null> {
  const own = await ownSettlement(tx, run, work);
  if (!own) {
    return null;
  }
  const { evidence, proof, terminal, workspaceId } = own;
  // A child created after the observation was never classified; never settle on it.
  if (!(await childObservationIsCurrent(tx, workspaceId, children))) {
    return null;
  }
  if (!(children.atRest || childHoldExpired(run, evidence))) {
    return null;
  }
  const status = terminal === 'COMPLETED' && result.pullRequests.length ? 'PR_CREATED' : terminal;
  return {
    evidence: { ...evidence, children: eventChildRestProof(children) },
    proof,
    status,
    reasonCode: children.atRest ? null : 'CHILD_HOLD_EXPIRED',
  };
}

/** When the run's own initial turn ended: its recorded outcome, else its stop evidence. */
export function initialTurnEndedAt(
  run: Pick<Run, 'initialDelivery'>,
  evidence: InitialDeliveryEvidence
) {
  if (evidence.outcome) {
    return run.initialDelivery.finishedAt;
  }
  return evidence.stop ? new Date(evidence.stop.observedAt) : null;
}

/** Durable child-hold deadline, measured from the end of the run's own initial turn. */
export function childHoldDeadline(
  run: Pick<Run, 'initialDelivery'>,
  evidence: InitialDeliveryEvidence
) {
  const ended = initialTurnEndedAt(run, evidence);
  return ended
    ? new Date(ended.getTime() + configService.getAgentRuntimeLimits().childHoldDeadlineMs)
    : null;
}

function childHoldExpired(run: Pick<Run, 'initialDelivery'>, evidence: InitialDeliveryEvidence) {
  const deadline = childHoldDeadline(run, evidence);
  return !!deadline && Date.now() >= deadline.getTime();
}

/**
 * The write lock serializes child creation (row and retained origin) with this
 * read, so an observation that matches the current child set is complete.
 */
export async function childObservationIsCurrent(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  observation: EventChildRest
) {
  const [rows, origins] = await Promise.all([
    tx.workspace.findMany({ where: { parentWorkspaceId: workspaceId }, select: { id: true } }),
    tx.workspaceChildOrigin.findMany({
      where: { parentWorkspaceId: workspaceId },
      select: { childWorkspaceId: true },
    }),
  ]);
  const current = new Set([
    ...rows.map((row) => row.id),
    ...origins.map((origin) => origin.childWorkspaceId),
  ]);
  const observed = new Set(observation.children.map((child) => child.workspaceId));
  return current.size === observed.size && [...current].every((id) => observed.has(id));
}
/** Positive stopped-source/work proof shared by recovery, settlement and retention. */
export function hasStoppedRunWork(evidence: InitialDeliveryEvidence, proof: EventWorkProof) {
  return (
    proof.mode === 'STOPPED' &&
    evidence.stop?.status === 'LOCAL_RUNTIME_GROUP_STOPPED' &&
    isDeepStrictEqual(evidence.source, proof.source) &&
    isDeepStrictEqual(evidence.stop.source, proof.source)
  );
}
export function assertAttempt(run: Run, expected: InitialAttempt) {
  const current = initialAttemptSchema.parse({
    runId: run.id,
    sessionId: run.reservedSessionId,
    workerGeneration: run.workerGeneration,
    attemptGeneration: run.attemptGeneration,
    messageId: run.initialDelivery.messageId,
    sendAttemptId: run.initialDelivery.sendAttemptId,
  });
  if (!isDeepStrictEqual(expected, current)) {
    launchConflict();
  }
}
export const agentRunSettlementAccessor = {
  observe(
    claim: EventLaunchClaim,
    attempt: InitialAttempt,
    result: Result,
    children: EventChildRest,
    work: EventWorkProof | null,
    assertCurrent: () => void
  ) {
    const incoming = agentRunResultSchema.parse(result);
    const observedChildren = eventChildRestSchema.parse(children);
    const expected = initialAttemptSchema.parse(attempt);
    const proof = work === null ? null : eventWorkProofSchema.parse(work);
    assertCurrent();
    return ledgerTransaction(async (tx) => {
      const run = await currentLaunch(tx, claim);
      assertAttempt(run, expected);
      const merged = mergeRunResults(run.result, incoming);
      const settlement = await settlementFor(tx, run, proof, merged, observedChildren);
      if (settlement) {
        await writeRunSettlement(
          tx,
          run.id,
          settlement.evidence,
          settlement.proof,
          merged,
          settlement.status,
          settlement.reasonCode
        );
      } else {
        await tx.agentRun.update({ where: { id: run.id }, data: { result: merged } });
      }
      // Linearization point. No application await follows; engine COMMIT is an acknowledged gap.
      assertCurrent();
      return settlement ? ('SETTLED' as const) : ('HELD' as const);
    });
  },
};
