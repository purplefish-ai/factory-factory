import { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
import type { ExportData } from '@/shared/schemas/export-data.schema';

/** Storage markers describe existing null values, never instructions to replace data. */
export function validateRecoveryJsonStorage(data: ExportData['data']) {
  const durable = data.durable;
  if (!durable || durable.jsonStorage.jsonNulls.length === 0) {
    return;
  }
  const rowsByModel: Readonly<Record<string, readonly unknown[]>> = {
    Workspace: data.workspaces,
    WorkspacePR: data.workspaces.flatMap((row) => row.prs),
    AgentSession: data.agentSessions,
    PeriodicTaskExecution: durable.periodicTaskExecution,
    AgentTrigger: durable.agentTrigger,
    AgentRun: durable.agentRun,
    AgentSourceState: durable.agentSourceState,
    AgentSourceCheckpoint: durable.agentSourceCheckpoint,
    AgentEvent: durable.agentEvent,
    AgentEvaluation: durable.agentEvaluation,
    AgentInitialDelivery: durable.agentInitialDelivery,
  };
  const indexes = new Map<string, Map<string, Record<string, unknown>>>();
  for (const marker of durable.jsonStorage.jsonNulls) {
    let index = indexes.get(marker.model);
    if (!index) {
      const primaryKey = marker.model === 'AgentSourceState' ? 'connectionId' : 'id';
      index = new Map(
        (rowsByModel[marker.model] ?? []).map((input): [string, Record<string, unknown>] => {
          const row = z.record(z.string(), z.unknown()).parse(input);
          return [
            marker.model === 'AgentSourceCheckpoint'
              ? JSON.stringify([z.string().parse(row.connectionId), z.string().parse(row.scanId)])
              : z.string().parse(row[primaryKey]),
            row,
          ];
        })
      );
      indexes.set(marker.model, index);
    }
    if (index.get(marker.id)?.[marker.field] !== null) {
      throw new ApplicationError(
        'INVALID_INPUT',
        'JSON storage marker does not match a retained null value'
      );
    }
  }
}
