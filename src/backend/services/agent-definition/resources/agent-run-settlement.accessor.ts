import { isDeepStrictEqual } from 'node:util';
import { agentRunResultSchema } from '@/shared/agent-runtime';
import {
  initialAttemptSchema,
  initialDeliveryEvidenceSchema,
  type InitialAttempt,
  type InitialDeliveryEvidence,
} from '@/shared/event-agent-delivery';
import { eventWorkProofSchema, type EventWorkProof } from '@/shared/event-agent-work';
import type { Prisma } from '@prisma-gen/client';
import type { EventLaunchClaim } from './agent-execution-binding.accessor';
import { currentLaunch, launchConflict } from './agent-launch.accessor';
import { ledgerTransaction } from './agent-ledger-transaction';
import { writeRunSettlement } from './agent-run-settlement-writes';

type Result = ReturnType<typeof agentRunResultSchema.parse>;
type Run = Awaited<ReturnType<typeof currentLaunch>>;
function mergeResults(stored: unknown, incoming: Result): Result {
  const previous = stored === null ? null : agentRunResultSchema.parse(stored);
  return agentRunResultSchema.parse({
    version: 1,
    summary: previous?.summary || incoming.summary,
    pullRequests: [
      ...new Map(
        [...(previous?.pullRequests ?? []), ...incoming.pullRequests].map((pr) => [
          pr.url.toLowerCase(),
          pr,
        ])
      ).values(),
    ].slice(0, 20),
  });
}
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
async function settlementFor(
  tx: Prisma.TransactionClient,
  run: Run,
  proof: EventWorkProof | null,
  result: Result
): Promise<{
  evidence: InitialDeliveryEvidence;
  proof: EventWorkProof;
  status: Parameters<typeof writeRunSettlement>[5];
} | null> {
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
  const stopped =
    proof.mode === 'STOPPED' &&
    evidence.stop?.status === 'LOCAL_RUNTIME_GROUP_STOPPED' &&
    isDeepStrictEqual(evidence.stop.source, proof.source);
  if (!terminal || ((terminal !== 'COMPLETED' || unavailable) && !stopped)) {
    return null;
  }
  if (!(await childHistoryIsClear(tx, run))) {
    return null;
  }
  const status = terminal === 'COMPLETED' && result.pullRequests.length ? 'PR_CREATED' : terminal;
  return { evidence, proof, status };
}
/** The write lock serializes child creation and its retained origin before settlement. */
export async function childHistoryIsClear(
  tx: Prisma.TransactionClient,
  run: Run
): Promise<boolean> {
  const workspaceId = run.reservedWorkspaceId;
  if (!workspaceId) {
    return false;
  }
  const origin = await tx.workspaceLaunchOrigin.findUnique({ where: { runId: run.id } });
  if (
    origin?.childHistoryVersion !== 1 ||
    origin.workspaceId !== workspaceId ||
    origin.projectId !== run.agentDefinition.projectId
  ) {
    return false;
  }
  const child = await tx.workspace.findFirst({
    where: { parentWorkspaceId: workspaceId },
    select: { id: true },
  });
  if (child) {
    return false;
  }
  return !(await tx.workspaceChildOrigin.findFirst({
    where: { parentWorkspaceId: workspaceId },
    select: { childWorkspaceId: true },
  }));
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
    work: EventWorkProof | null,
    assertCurrent: () => void
  ) {
    const incoming = agentRunResultSchema.parse(result);
    const expected = initialAttemptSchema.parse(attempt);
    const proof = work === null ? null : eventWorkProofSchema.parse(work);
    assertCurrent();
    return ledgerTransaction(async (tx) => {
      const run = await currentLaunch(tx, claim);
      assertAttempt(run, expected);
      const merged = mergeResults(run.result, incoming);
      const settlement = await settlementFor(tx, run, proof, merged);
      if (settlement) {
        await writeRunSettlement(
          tx,
          run.id,
          settlement.evidence,
          settlement.proof,
          merged,
          settlement.status
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
