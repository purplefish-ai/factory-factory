export {
  restoreWorkspaceScheduleLinks,
  restoreRecoveryNotifications,
} from '../../resources/workspace-recovery';

import type { RecoveryImportedIds } from '@/shared/recovery-graph';
import type { ExportData } from '@/shared/schemas/export-data.schema';
import type { Prisma } from '@prisma-gen/client';
import { restoreRecoveryChildOrigins } from '../../resources/workspace-child-origin.accessor';
import { restoreRecoveryWorkspaceOrigins } from '../../resources/workspace-launch-origin.accessor';

export async function restoreRetainedWorkspaceRecovery(
  tx: Prisma.TransactionClient,
  data: ExportData['data'],
  ids: RecoveryImportedIds
) {
  const incomplete = await restoreRecoveryChildOrigins(tx, data, ids);
  await restoreRecoveryWorkspaceOrigins(tx, data, ids, incomplete);
}
