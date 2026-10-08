import { isPRMonitoringRecipient } from '@/shared/pr-monitoring';
import { wakePRDelivery } from './pr-event-delivery.orchestrator';
import {
  defaultPRMonitoringServices,
  type PRMonitoringServices,
} from './pr-monitoring-dependencies';

export async function setPRMonitoring(
  input: {
    workspaceId: string;
    enabled: boolean;
    recipientSessionId?: string | null;
    expectedBindingRevision: number;
  },
  services: PRMonitoringServices = defaultPRMonitoringServices
) {
  const {
    workspacePRMonitoringService,
    sessionDataService,
    sessionBackgroundDeliveryService,
    userSettingsService,
  } = services;
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
  const settings = input.enabled ? await userSettingsService.get() : null;
  const result = await workspacePRMonitoringService.setBinding({
    ...input,
    recipientSessionId,
    replyToPrComments: settings?.ratchetReplyToPrComments,
  });
  if (!result.applied) {
    throw new Error('PR monitoring changed while this request was in progress; refresh and retry');
  }
  if (previous && previous.bindingRevision !== result.bindingRevision) {
    sessionBackgroundDeliveryService.invalidate(input.workspaceId, previous.bindingRevision);
  }
  if (input.enabled && recipientSessionId) {
    await workspacePRMonitoringService.addEnabledControl(
      input.workspaceId,
      result.bindingRevision,
      settings?.ratchetReplyToPrComments ?? false
    );
  }
  await wakePRDelivery(input.workspaceId, services);
  return { status: 'updated' as const, bindingRevision: result.bindingRevision };
}
export async function bindIssueMonitoringSession(
  workspaceId: string,
  sessionId: string,
  services: PRMonitoringServices = defaultPRMonitoringServices
) {
  const config = await services.workspacePRMonitoringService.get(workspaceId);
  if (config?.enabled && !config.recipientSessionId) {
    await setPRMonitoring(
      {
        workspaceId,
        enabled: true,
        recipientSessionId: sessionId,
        expectedBindingRevision: config.bindingRevision,
      },
      services
    );
  }
}
