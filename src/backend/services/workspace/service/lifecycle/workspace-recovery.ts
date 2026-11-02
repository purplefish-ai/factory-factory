export {
  restoreWorkspaceScheduleLinks,
  restoreRecoveryNotifications,
} from '@/backend/services/workspace/resources/workspace-recovery';

import { restoreRecoveryChildOrigins } from '@/backend/services/workspace/resources/workspace-child-origin.accessor';
import { restoreRecoveryWorkspaceOrigins } from '@/backend/services/workspace/resources/workspace-launch-origin.accessor';
import type { RecoveryImportedIds } from '@/shared/recovery-graph';
import type { ExportData } from '@/shared/schemas/export-data.schema';
import type { Prisma } from '@prisma-gen/client';

export async function restoreRetainedWorkspaceRecovery(
  tx: Prisma.TransactionClient,
  data: ExportData['data'],
  ids: RecoveryImportedIds
) {
  const incomplete = await restoreRecoveryChildOrigins(tx, data, ids);
  await restoreRecoveryWorkspaceOrigins(tx, data, ids, incomplete);
}
