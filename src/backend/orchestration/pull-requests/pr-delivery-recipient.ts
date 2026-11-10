import { isPRMonitoringRecipient, PR_DEDICATED_WORKFLOW } from '@/shared/pr-monitoring';
import type { PRRecipientPorts } from './pr-monitoring-ports';

type MonitoringConfig = { recipientSessionId: string | null; deliveryMode?: string };
type Recipient = {
  id: string;
  workspaceId: string;
  workspacePrId?: string | null;
  workflow?: string | null;
};

export async function isCurrentPRRecipient(
  config: MonitoringConfig,
  session: Recipient,
  prId: string | null,
  services: PRRecipientPorts
): Promise<boolean> {
  if ((config.deliveryMode ?? 'MAIN') === 'MAIN') {
    return config.recipientSessionId === session.id && isPRMonitoringRecipient(session);
  }
  if (!prId || session.workflow !== PR_DEDICATED_WORKFLOW || session.workspacePrId !== prId) {
    return false;
  }
  const bound = await services.sessionDataService.findPRDedicatedSession({
    workspaceId: session.workspaceId,
    prId,
  });
  return bound?.id === session.id;
}
