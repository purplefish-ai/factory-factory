import { isDeepStrictEqual } from 'node:util';
import type { agentManagementHistoryAccessor } from '@/backend/services/agent-definition/resources/agent-management-history.accessor';
import { initialDeliveryEvidenceSchema } from '@/shared/event-agent-delivery';
import { eventLaunchPreparationSchema } from '@/shared/event-agent-preparation';
import {
  agentRecoveryTargetSchema,
  eventRunRecoveryContextSchema,
} from '@/shared/event-agent-recovery';

type Row = Awaited<ReturnType<typeof agentManagementHistoryAccessor.recoveryTarget>>;
export function recoveryTargetProjection(
  reference: { projectId: string; agentId: string; runId: string },
  row: Row
) {
  const unavailable = (reason: 'NOT_FOUND' | 'NOT_RECOVERABLE' | 'INVALID_STORED_DATA') =>
    agentRecoveryTargetSchema.parse({ ...reference, status: 'UNAVAILABLE', reason });
  if (!row) {
    return unavailable('NOT_FOUND');
  }
  if (row.status !== 'RUNNING') {
    return unavailable('NOT_RECOVERABLE');
  }
  try {
    const delivery = row.initialDelivery;
    if (
      !delivery ||
      delivery.runId !== row.id ||
      delivery.attemptGeneration !== row.attemptGeneration
    ) {
      return unavailable('INVALID_STORED_DATA');
    }
    const context = eventRunRecoveryContextSchema.parse({
      projectId: reference.projectId,
      claim: {
        status: 'CLAIMED',
        runId: row.id,
        workerGeneration: row.workerGeneration,
        attemptGeneration: row.attemptGeneration,
        reservedWorkspaceId: row.reservedWorkspaceId,
        reservedSessionId: row.reservedSessionId,
        initialMessageId: row.initialMessageId,
      },
      attempt: {
        runId: row.id,
        sessionId: row.reservedSessionId,
        messageId: delivery.messageId,
        sendAttemptId: delivery.sendAttemptId,
        workerGeneration: row.workerGeneration,
        attemptGeneration: row.attemptGeneration,
      },
    });
    if (delivery.evidence !== null) {
      const evidence = initialDeliveryEvidenceSchema.parse(delivery.evidence);
      if (
        !isDeepStrictEqual(
          { ...evidence.attempt, workerGeneration: row.workerGeneration },
          context.attempt
        )
      ) {
        return unavailable('INVALID_STORED_DATA');
      }
    }
    const preparation =
      row.launchPreparation === null
        ? null
        : eventLaunchPreparationSchema.parse(row.launchPreparation);
    return agentRecoveryTargetSchema.parse({
      ...reference,
      status: 'AVAILABLE',
      context,
      run: {
        status: row.status,
        launchPhase: row.launchPhase,
        deliveryState: delivery.state,
        preparationState: preparation?.state ?? null,
      },
    });
  } catch {
    return unavailable('INVALID_STORED_DATA');
  }
}
