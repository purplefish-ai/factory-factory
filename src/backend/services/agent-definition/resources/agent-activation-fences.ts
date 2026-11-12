import type { AgentPausedReasonCode } from '@/shared/agent-management';
import { agentSourceHealthSchema } from '@/shared/agent-runtime';
import type { Prisma } from '@prisma-gen/client';
import { hasCurrentValidatedIntent, type RuntimeTrigger } from './agent-runtime-guards';
import { pauseTriggers } from './agent-trigger-pause';

type Tx = Prisma.TransactionClient;
/** One STARTING generation; every write below is fenced on this exact generation. */
export type StartingTrigger = { triggerId: string; connectionId: string; generation: number };

/** Null when no health is recorded; malformed stored health is reported as INVALID. */
export function activationSourceHealth(trigger: RuntimeTrigger) {
  const stored = trigger.connection?.sourceState?.health;
  if (stored == null) {
    return null;
  }
  const health = agentSourceHealthSchema.safeParse(stored);
  return health.success ? health.data.state : 'INVALID';
}

/** Returns this exact STARTING generation to PAUSED, recording why when there is a reason. */
export async function failStartingInTransaction(
  tx: Tx,
  trigger: StartingTrigger,
  reason: AgentPausedReasonCode | null
) {
  const where = {
    id: trigger.triggerId,
    activationState: 'STARTING' as const,
    activationGeneration: trigger.generation,
  };
  const { pausedTriggerCount } = await pauseTriggers(tx, where);
  if (pausedTriggerCount && reason) {
    await tx.agentTrigger.update({
      where: { id: trigger.triggerId },
      data: { pausedReasonCode: reason },
    });
  }
}

/** The definition, trigger revision, connection and project still permit this generation. */
export function permitsPending(
  trigger: RuntimeTrigger,
  pending: { triggerRevision: number; connectionId: string; definitionRevision: number }
) {
  const definition = trigger.agentDefinition;
  return (
    trigger.isConfigured === true &&
    trigger.triggerRevision === pending.triggerRevision &&
    trigger.connectionId === pending.connectionId &&
    definition.definitionRevision === pending.definitionRevision &&
    definition.isEnabled &&
    hasCurrentValidatedIntent(definition) &&
    !definition.project.isArchived
  );
}
