import { z } from 'zod';
import { PeriodicTaskCadence, PeriodicTaskExecutionStatus } from '@/shared/core';

const periodicTaskSchema = z.strictObject({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  prompt: z.string(),
  cadence: z.enum(PeriodicTaskCadence),
  scheduledTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable(),
  timezone: z
    .string()
    .refine((timeZone) => {
      try {
        new Intl.DateTimeFormat(undefined, { timeZone });
        return true;
      } catch {
        return false;
      }
    }, 'Invalid timezone')
    .nullable(),
  scheduledDayOfMonth: z.number().int().min(1).max(31).nullable(),
  isEnabled: z.boolean(),
  nextRunAt: z.iso.datetime(),
  lastRunAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const periodicConfigRecoverySchema = z
  .strictObject({
    version: z.literal(1),
    tasks: z.array(periodicTaskSchema),
  })
  .superRefine((section, ctx) => {
    const ids = new Set<string>();
    for (const task of section.tasks) {
      if (ids.has(task.id)) {
        ctx.addIssue({ code: 'custom', message: 'Duplicate periodic task identity' });
      }
      ids.add(task.id);
    }
  });
export type PeriodicConfigRecovery = z.infer<typeof periodicConfigRecoverySchema>;

const launchSnapshotSchema = z.strictObject({
  version: z.literal(1),
  projectId: z.string(),
  name: z.string(),
  prompt: z.string(),
  cadence: z.enum(PeriodicTaskCadence),
  scheduledTime: z.string().nullable(),
  timezone: z.string().nullable(),
  scheduledDayOfMonth: z.number().int().nullable(),
  dueAt: z.iso.datetime(),
});
export const periodicHistoryRecoverySchema = z
  .strictObject({
    version: z.literal(1),
    executions: z.array(
      z.strictObject({
        id: z.string(),
        periodicTaskId: z.string(),
        workspaceId: z.string().nullable(),
        launchSnapshot: launchSnapshotSchema.nullable(),
        status: z.enum(PeriodicTaskExecutionStatus),
        prUrl: z.string().nullable(),
        prNumber: z.number().int().nullable(),
        errorMessage: z.string().nullable(),
        startedAt: z.iso.datetime(),
        completedAt: z.iso.datetime().nullable(),
      })
    ),
    jsonStorage: z.array(
      z.strictObject({
        model: z.literal('PeriodicTaskExecution'),
        identity: z.tuple([z.string()]),
        field: z.literal('launchSnapshot'),
      })
    ),
  })
  .superRefine((section, ctx) => {
    const ids = new Set<string>();
    const slots = new Set<string>();
    section.executions.forEach((row, index) => {
      if (ids.has(row.id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Duplicate execution identity',
          path: ['executions', index, 'id'],
        });
      }
      if (row.workspaceId !== null && slots.has(row.workspaceId)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Duplicate execution workspace',
          path: ['executions', index, 'workspaceId'],
        });
      }
      ids.add(row.id);
      if (row.workspaceId !== null) {
        slots.add(row.workspaceId);
      }
    });
    const rows = new Map(section.executions.map((row) => [row.id, row]));
    const marked = new Set<string>();
    section.jsonStorage.forEach((marker, index) => {
      const id = marker.identity[0];
      if (marked.has(id) || !rows.has(id) || rows.get(id)?.launchSnapshot !== null) {
        ctx.addIssue({
          code: 'custom',
          message: 'Invalid execution JSON-null target',
          path: ['jsonStorage', index, 'identity'],
        });
      }
      marked.add(id);
    });
  });
export type PeriodicHistoryRecovery = z.infer<typeof periodicHistoryRecoverySchema>;
