import * as recovery from '@/backend/services/agent-definition/resources/agent-definition-recovery';
import type { AutomationDefinitionsRecovery } from '@/shared/schemas/automation-definitions-recovery.schema';
import type { Prisma } from '@prisma-gen/client';

export function exportAutomationDefinitionsRecovery(tx: Prisma.TransactionClient) {
  return recovery.exportAutomationDefinitionsRecovery(tx);
}

export function planAutomationDefinitionsRecovery(
  tx: Prisma.TransactionClient,
  section: AutomationDefinitionsRecovery,
  plannedCreatedProjectIds: ReadonlySet<string>
) {
  return recovery.planAutomationDefinitionsRecovery(tx, section, plannedCreatedProjectIds);
}

export function restoreAutomationDefinitionsRecovery(
  tx: Prisma.TransactionClient,
  plan: Awaited<ReturnType<typeof recovery.planAutomationDefinitionsRecovery>>,
  actualCreatedProjectIds: ReadonlySet<string>
) {
  return recovery.restoreAutomationDefinitionsRecovery(tx, plan, actualCreatedProjectIds);
}
