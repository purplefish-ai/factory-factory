import { restoreRecoverySessionOrigins } from '@/backend/services/session/resources/agent-session-launch-origin.accessor';
import { restoreRecoveryChatIntents } from '@/backend/services/session/resources/chat-intent.accessor';
import { restoreRecoveryLifecycleEvents } from '@/backend/services/session/resources/session-lifecycle-event.accessor';
import type { RecoveryImportedIds } from '@/shared/recovery-graph';
import type { ExportData } from '@/shared/schemas/export-data.schema';
import type { Prisma } from '@prisma-gen/client';

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

export { validateRecoveryChatIntentFingerprints } from '@/backend/services/session/resources/chat-intent.accessor';
