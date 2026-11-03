import * as recovery from '@/backend/services/periodic-task/resources/periodic-recovery';
import type { PeriodicConfigRecovery } from '@/shared/schemas/periodic-recovery.schema';
import type { Prisma } from '@prisma-gen/client';

export function exportPeriodicConfigRecovery(tx: Prisma.TransactionClient) {
  return recovery.exportPeriodicConfigRecovery(tx);
}

export function restorePeriodicConfigRecovery(
  tx: Prisma.TransactionClient,
  section: PeriodicConfigRecovery,
  acceptedProjectIds: ReadonlySet<string>
) {
  return recovery.restorePeriodicConfigRecovery(tx, section, acceptedProjectIds);
}
