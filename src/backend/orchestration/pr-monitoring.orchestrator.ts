import { sessionBackgroundDeliveryService, sessionDataService } from '@/backend/services/session';
import { userSettingsService } from '@/backend/services/settings';
import { workspacePRMonitoringService } from '@/backend/services/workspace';
import { isPRMonitoringRecipient } from '@/shared/pr-monitoring';
import { wakePRDelivery } from './pr-event-delivery.orchestrator';

export async function setPRMonitoring(input: {
  workspaceId: string;
  enabled: boolean;
  recipientSessionId?: string | null;
  expectedBindingRevision: number;
}) {
  const previous = await workspacePRMonitoringService.get(input.workspaceId);
  let recipientSessionId =
    input.recipientSessionId === undefined
      ? (previous?.recipientSessionId ?? null)
      : input.recipientSessionId;
  if (input.enabled && !recipientSessionId) {
    const sessions = (
      await sessionDataService.findAgentSessionsByWorkspaceId(input.workspaceId)
    ).filter(isPRMonitoringRecipient);
    if (sessions.length !== 1) {
      return {
        status: 'recipient_required' as const,
        bindingRevision: previous?.bindingRevision ?? 0,
        candidates: sessions.map((s) => ({ id: s.id, name: s.name, provider: s.provider })),
      };
    }
    recipientSessionId = sessions[0]?.id ?? null;
  }
  const result = await workspacePRMonitoringService.setBinding({ ...input, recipientSessionId });
  if (!result.applied) {
    throw new Error('PR monitoring changed while this request was in progress; refresh and retry');
  }
  if (previous && previous.bindingRevision !== result.bindingRevision) {
    sessionBackgroundDeliveryService.invalidate(input.workspaceId, previous.bindingRevision);
  }
  if (
    input.enabled &&
    recipientSessionId &&
    (!previous?.enabled || previous.recipientSessionId !== recipientSessionId)
  ) {
    const settings = await userSettingsService.get();
    await workspacePRMonitoringService.addEnabledControl(
      input.workspaceId,
      result.bindingRevision,
      settings.ratchetReplyToPrComments
    );
  }
  await wakePRDelivery(input.workspaceId);
  return { status: 'updated' as const, bindingRevision: result.bindingRevision };
}
export async function bindIssueMonitoringSession(workspaceId: string, sessionId: string) {
  const config = await workspacePRMonitoringService.get(workspaceId);
  if (config?.enabled && !config.recipientSessionId) {
    await setPRMonitoring({
      workspaceId,
      enabled: true,
      recipientSessionId: sessionId,
      expectedBindingRevision: config.bindingRevision,
    });
  }
}
