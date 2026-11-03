import { z } from 'zod';
import { PeriodicTaskCadence } from '@/shared/core';

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
