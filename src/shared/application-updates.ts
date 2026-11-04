import { z } from 'zod';

export const releaseVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
export const applicationUpdateStatusSchema = z
  .object({
    phase: z.enum(['idle', 'waiting', 'preparing', 'restarting', 'failed']),
    targetVersion: releaseVersionSchema.optional(),
    error: z.string().optional(),
  })
  .refine(
    (status) =>
      status.phase === 'idle' || status.phase === 'failed' || status.targetVersion !== undefined,
    { message: 'An active update requires a target version.', path: ['targetVersion'] }
  );
export type ApplicationUpdateStatus = z.infer<typeof applicationUpdateStatusSchema>;
export interface UpdateNotice {
  id: 'factory-factory' | 'claude' | 'codex';
  label: string;
  currentVersion: string;
  latestVersion: string;
}
export interface ApplicationUpdates {
  currentVersion: string;
  notices: UpdateNotice[];
  automaticUpdate: boolean;
  manualCommand: string;
  status: ApplicationUpdateStatus;
}
export const updateSupervisorMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('update-hello') }),
  z.object({ type: z.literal('update-backend-ready') }),
  z.object({ type: z.literal('update-request'), version: releaseVersionSchema }),
  z.object({ type: z.literal('update-cancel') }),
  z.object({ type: z.literal('update-ready') }),
  z.object({
    type: z.literal('update-capabilities'),
    automaticUpdate: z.boolean(),
    manualCommand: z.string(),
  }),
  z.object({ type: z.literal('update-status'), status: applicationUpdateStatusSchema }),
]);

export type UpdateSupervisorMessage = z.infer<typeof updateSupervisorMessageSchema>;
