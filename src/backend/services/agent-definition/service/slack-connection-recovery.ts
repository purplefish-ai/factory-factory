import * as recovery from '@/backend/services/agent-definition/resources/slack-connection-recovery';
import type { SlackConnectionsRecovery } from '@/shared/schemas/slack-connections-recovery.schema';
import type { Prisma } from '@prisma-gen/client';

export function exportSlackConnectionsRecovery(tx: Prisma.TransactionClient) {
  return recovery.exportSlackConnectionsRecovery(tx);
}
export function planSlackConnectionsRecovery(
  tx: Prisma.TransactionClient,
  section: SlackConnectionsRecovery
) {
  return recovery.planSlackConnectionsRecovery(tx, section);
}
export function restoreSlackConnectionsRecovery(
  tx: Prisma.TransactionClient,
  plan: Awaited<ReturnType<typeof recovery.planSlackConnectionsRecovery>>
) {
  return recovery.restoreSlackConnectionsRecovery(tx, plan);
}
