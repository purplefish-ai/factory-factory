import type { AgentCadence } from './types';

export const AGENT_CADENCE_LABELS: Record<AgentCadence, string> = {
  EVERY_MINUTE: 'Every minute',
  EVERY_FIVE_MINUTES: 'Every 5 minutes',
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
  MONTHLY: 'Monthly',
};

export function supportsAgentClockTime(cadence: AgentCadence): boolean {
  return cadence === 'DAILY' || cadence === 'WEEKLY' || cadence === 'MONTHLY';
}

export function resolveAgentSchedule(
  draft: { cadence: AgentCadence; scheduledTime: string },
  previous?: { scheduledTime: string | null; timezone: string | null },
  browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone
): { scheduledTime: string | null; timezone: string | null } {
  if (!(supportsAgentClockTime(draft.cadence) && draft.scheduledTime)) {
    return { scheduledTime: null, timezone: null };
  }
  return {
    scheduledTime: draft.scheduledTime,
    timezone:
      draft.scheduledTime === previous?.scheduledTime && previous.timezone
        ? previous.timezone
        : browserTimezone,
  };
}

export function describeAgentSchedule(agent: {
  cadence: AgentCadence;
  scheduledTime: string | null;
  timezone: string | null;
}): string {
  const label = AGENT_CADENCE_LABELS[agent.cadence];
  return supportsAgentClockTime(agent.cadence) && agent.scheduledTime
    ? `${label} at ${agent.scheduledTime}${agent.timezone ? ` (${agent.timezone})` : ''}`
    : label;
}
