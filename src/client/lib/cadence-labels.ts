import type { PeriodicTaskCadence } from '@/shared/core';

export const CADENCE_LABELS: Record<PeriodicTaskCadence, string> = {
  EVERY_MINUTE: 'Every minute',
  EVERY_FIVE_MINUTES: 'Every 5 minutes',
  EVERY_HOUR: 'Every hour',
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
  MONTHLY: 'Monthly',
};

export function cadenceLabel(cadence: string): string {
  return CADENCE_LABELS[cadence as PeriodicTaskCadence] ?? cadence;
}
