import { z } from 'zod';

/** Secret fields and disposable preference caches are deliberately absent. */
export const nullableRecoveryJsonFields: Readonly<Record<string, readonly string[]>> = {
  Workspace: ['creationMetadata'],
  WorkspacePR: ['observation'],
  AgentSession: ['providerMetadata'],
  PeriodicTaskExecution: ['launchSnapshot'],
  AgentTrigger: ['activationBoundary', 'pendingActivation'],
  AgentRun: ['result', 'effectiveExecution', 'launchPreparation', 'triggerSnapshot'],
  AgentSourceState: ['cursor', 'health'],
  AgentEvent: ['payload'],
  AgentEvaluation: ['classifier'],
  AgentInitialDelivery: ['evidence'],
};
const jsonNullMarkerSchema = z
  .strictObject({
    model: z.enum(Object.keys(nullableRecoveryJsonFields)),
    id: z.string().min(1),
    field: z.string().min(1),
  })
  .superRefine((marker, ctx) => {
    if (!nullableRecoveryJsonFields[marker.model]?.includes(marker.field)) {
      ctx.addIssue({ code: 'custom', message: 'Unsupported nullable JSON storage field' });
    }
  });
export const recoveryJsonStorageSchema = z
  .strictObject({
    version: z.literal(1),
    jsonNulls: z.array(jsonNullMarkerSchema),
  })
  .superRefine((storage, ctx) => {
    const keys = storage.jsonNulls.map(({ model, id, field }) =>
      JSON.stringify([model, id, field])
    );
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate JSON storage marker' });
    }
  });
export type RecoveryJsonStorage = z.infer<typeof recoveryJsonStorageSchema>;
export function recoveryJsonNullLookup(storage: RecoveryJsonStorage) {
  const keys = new Set(
    storage.jsonNulls.map(({ model, id, field }) => JSON.stringify([model, id, field]))
  );
  return (model: string, id: string, field: string) => keys.has(JSON.stringify([model, id, field]));
}
export type RecoveryJsonNullLookup = ReturnType<typeof recoveryJsonNullLookup>;
