import { z } from 'zod';

/**
 * Cadence input schemas shared by `periodic-task.trpc.ts` and
 * `workspace-wake.trpc.ts` — both schedule on the same `PeriodicTaskCadence`
 * values with the same optional time-of-day/timezone fields.
 */

export const cadenceSchema = z.enum([
  'EVERY_MINUTE',
  'EVERY_FIVE_MINUTES',
  'EVERY_HOUR',
  'DAILY',
  'WEEKLY',
  'MONTHLY',
]);

export const scheduledTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be a valid HH:MM time (00:00–23:59)')
  .nullable()
  .optional();

export const timezoneSchema = z
  .string()
  .refine(
    (tz) => {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Must be a valid IANA timezone (e.g. America/New_York)' }
  )
  .nullable()
  .optional();
