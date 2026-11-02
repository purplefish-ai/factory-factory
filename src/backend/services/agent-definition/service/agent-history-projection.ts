import { ApplicationError } from '@/backend/lib/application-error';
import type { agentManagementHistoryAccessor } from '@/backend/services/agent-definition/resources/agent-management-history.accessor';
import { SERVICE_TIMEOUT_MS } from '@/backend/services/constants';
import { agentRunHistorySchema } from '@/shared/agent-history';
import { agentRunResultSchema } from '@/shared/agent-runtime';
import { initialDeliveryEvidenceSchema } from '@/shared/event-agent-delivery';
import { eventLaunchPreparationSchema } from '@/shared/event-agent-preparation';

export function publicReason(reason: string | null) {
  return reason === null
    ? null
    : /^[A-Z][A-Z0-9_]{0,99}$/.test(reason)
      ? reason
      : 'INVALID_STORED_DATA';
}
const timestamp = (value: Date | null) => value?.toISOString() ?? null;

export function runHistoryProjection(
  row: Awaited<ReturnType<typeof agentManagementHistoryAccessor.runs>>[number]
) {
  if (row.reservedWorkspaceId && row.workspaceId && row.reservedWorkspaceId !== row.workspaceId) {
    throw new ApplicationError('NOT_FOUND', 'The run workspace does not match its reservation.');
  }
  const preparation = eventLaunchPreparationSchema.safeParse(row.launchPreparation);
  const evidence = initialDeliveryEvidenceSchema.safeParse(row.initialDelivery?.evidence);
  const result = agentRunResultSchema.safeParse(row.result);
  const outcome = evidence.success ? evidence.data.outcome : undefined;
  return agentRunHistorySchema.parse({
    id: row.id,
    agentId: row.agentDefinitionId,
    triggerId: row.triggerId,
    eventId: row.eventId,
    createdAt: row.createdAt.toISOString(),
    startedAt: timestamp(row.startedAt),
    completedAt: timestamp(row.completedAt),
    status: row.status,
    launchPhase: row.launchPhase,
    reasonCode: publicReason(row.reasonCode),
    attemptCount: row.attemptCount,
    attemptGeneration: row.attemptGeneration,
    nextAttemptAt: timestamp(row.nextAttemptAt),
    expiresAt: timestamp(row.expiresAt),
    setupDeadlineAt:
      preparation.success && preparation.data.setupStartedAt
        ? new Date(
            Date.parse(preparation.data.setupStartedAt) + SERVICE_TIMEOUT_MS.eventWorkspaceSetup
          ).toISOString()
        : null,
    turnDeadlineAt: row.initialDelivery?.sendingAt
      ? new Date(row.initialDelivery.sendingAt.getTime() + 4 * 60 * 60 * 1000).toISOString()
      : null,
    preparation: preparation.success ? preparation.data : null,
    delivery: row.initialDelivery
      ? {
          state: row.initialDelivery.state,
          sendingAt: timestamp(row.initialDelivery.sendingAt),
          acceptedAt: timestamp(row.initialDelivery.acceptedAt),
          finishedAt: timestamp(row.initialDelivery.finishedAt),
        }
      : null,
    initialOutcome: outcome ? { result: outcome.result, stopReason: outcome.stopReason } : null,
    result: result.success ? result.data : null,
    reservedWorkspaceId: row.reservedWorkspaceId,
    reservedSessionId: row.reservedSessionId,
    workspaceId: row.workspaceId,
    workspaceState: row.workspaceId ? 'LIVE' : row.reservedWorkspaceId ? 'RESERVED' : 'UNRESERVED',
  });
}
