import type { agentRunResultSchema } from '@/shared/agent-runtime';
import type { InitialDeliveryEvidence } from '@/shared/event-agent-delivery';
import type { EventWorkProof } from '@/shared/event-agent-work';
import type { Prisma } from '@prisma-gen/client';

export async function writeRunSettlement(
  tx: Prisma.TransactionClient,
  runId: string,
  evidence: InitialDeliveryEvidence,
  proof: EventWorkProof,
  result: ReturnType<typeof agentRunResultSchema.parse>,
  status: 'COMPLETED' | 'PR_CREATED' | 'FAILED' | 'CANCELLED'
) {
  await tx.agentInitialDelivery.update({
    where: { runId },
    data: {
      state: 'FINISHED',
      ...(evidence.outcome ? {} : { finishedAt: new Date() }),
      evidence: { ...evidence, work: proof },
    },
  });
  await tx.agentRun.update({
    where: { id: runId },
    data: {
      status,
      launchPhase: 'FINISHED',
      result,
      completedAt: new Date(),
      leaseExpiresAt: null,
      nextAttemptAt: null,
      reasonCode: null,
    },
  });
}
