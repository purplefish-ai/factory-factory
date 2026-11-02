import type { RecoveryImportedIds } from '@/shared/recovery-graph';
import type { ExportData } from '@/shared/schemas/export-data.schema';
import type { Prisma } from '@prisma-gen/client';
import { restoreRecoverySessionOrigins } from '../../resources/agent-session-launch-origin.accessor';
import { restoreRecoveryChatIntents } from '../../resources/chat-intent.accessor';
import { restoreRecoveryLifecycleEvents } from '../../resources/session-lifecycle-event.accessor';

export async function restoreRetainedSessionRecovery(
  tx: Prisma.TransactionClient,
  data: ExportData['data'],
  ids: RecoveryImportedIds
) {
  if (data.durable) {
    await restoreRecoveryChatIntents(tx, data.durable, ids.sessions);
  }
  await restoreRecoverySessionOrigins(tx, data, ids);
  await restoreRecoveryLifecycleEvents(tx, data, ids);
}
