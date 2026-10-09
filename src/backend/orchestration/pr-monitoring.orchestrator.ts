import { isPRMonitoringRecipient, type PRDeliveryMode } from '@/shared/pr-monitoring';
import { createPRDeliveryPorts } from './pr-delivery-dependencies';
import { wakePRDelivery } from './pr-event-delivery.orchestrator';
import {
  defaultPRMonitoringServices,
  type PRMonitoringServices,
} from './pr-monitoring-dependencies';

const BINDING_CHANGED_MESSAGE =
  'PR monitoring changed while this request was in progress; refresh and retry';

function assertBindingRevision(actual: number, expected: number) {
  if (actual !== expected) {
    throw new Error(BINDING_CHANGED_MESSAGE);
  }
}

export async function setPRMonitoring(
  input: {
    workspaceId: string;
    enabled: boolean;
    deliveryMode?: PRDeliveryMode;
    resume?: boolean;
    recipientSessionId?: string | null;
    expectedBindingRevision: number;
  },
  services: PRMonitoringServices = defaultPRMonitoringServices
) {
  const { workspacePRMonitoringService, sessionBackgroundDeliveryService, userSettingsService } =
    services;
  const previous = await workspacePRMonitoringService.get(input.workspaceId);
  assertBindingRevision(previous?.bindingRevision ?? 0, input.expectedBindingRevision);
  const deliveryMode = input.deliveryMode ?? previous?.deliveryMode ?? 'MAIN';
  const preferredRecipient =
    input.recipientSessionId === undefined
      ? (previous?.recipientSessionId ?? null)
      : input.recipientSessionId;
  const recipient = await resolvePRMonitoringRecipient(
    input,
    deliveryMode,
    preferredRecipient,
    services
  );
  if (recipient.status === 'recipient_required') {
    return recipient;
  }
  const { recipientSessionId } = recipient;
  const settings = input.enabled ? await userSettingsService.get() : null;
  const result = await workspacePRMonitoringService.setBinding({
    ...input,
    recipientSessionId,
    replyToPrComments: settings?.ratchetReplyToPrComments,
  });
  if (!result.applied) {
    throw new Error(BINDING_CHANGED_MESSAGE);
  }
  if (previous && previous.bindingRevision !== result.bindingRevision) {
    sessionBackgroundDeliveryService.invalidate(input.workspaceId, previous.bindingRevision);
  }
  if (shouldAddControl(input, deliveryMode, recipientSessionId)) {
    await workspacePRMonitoringService.addEnabledControl(
      input.workspaceId,
      result.bindingRevision,
      settings?.ratchetReplyToPrComments ?? false
    );
  }
  await wakePRDelivery(input.workspaceId, createPRDeliveryPorts(services));
  return { status: 'updated' as const, bindingRevision: result.bindingRevision };
}
async function resolvePRMonitoringRecipient(
  input: { workspaceId: string; enabled: boolean; expectedBindingRevision: number },
  deliveryMode: PRDeliveryMode,
  preferredRecipient: string | null,
  services: PRMonitoringServices
) {
  if (input.enabled && deliveryMode === 'MAIN' && !preferredRecipient) {
    const sessions = (
      await services.sessionDataService.findAgentSessionsByWorkspaceId(input.workspaceId)
    ).filter(isPRMonitoringRecipient);
    const current = await services.workspacePRMonitoringService.get(input.workspaceId);
    assertBindingRevision(current?.bindingRevision ?? 0, input.expectedBindingRevision);
    if (sessions.length !== 1) {
      return {
        status: 'recipient_required' as const,
        bindingRevision: input.expectedBindingRevision,
        candidates: sessions.map((session) => ({
          id: session.id,
          name: session.name,
          provider: session.provider,
        })),
      };
    }
    return { status: 'selected' as const, recipientSessionId: sessions[0]?.id ?? null };
  }
  return { status: 'selected' as const, recipientSessionId: preferredRecipient };
}

export async function bindIssueMonitoringSession(
  workspaceId: string,
  sessionId: string,
  services: PRMonitoringServices = defaultPRMonitoringServices
) {
  const config = await services.workspacePRMonitoringService.get(workspaceId);
  if (config?.enabled && (config.deliveryMode ?? 'MAIN') === 'MAIN' && !config.recipientSessionId) {
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

function shouldAddControl(
  input: { enabled: boolean; resume?: boolean },
  mode: PRDeliveryMode,
  recipient: string | null
) {
  return input.enabled && !input.resume && mode === 'MAIN' && !!recipient;
}
