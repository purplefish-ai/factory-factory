import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { EventInitialPermit, EventSessionAuthority } from './event-session-authority';
import { createSessionLaunchMetadata } from './session-launch-settings';

type GuardedStartup = { eventInitial?: EventInitialPermit; assertCurrent?: () => Promise<void> };
export async function guardEventStartup<T extends GuardedStartup>(
  authority: EventSessionAuthority | undefined,
  id: string,
  options: T
): Promise<T> {
  if (!authority) {
    return options;
  }
  const permit = options.eventInitial;
  await authority.assertStartup(id, permit);
  return {
    ...options,
    ...(permit
      ? {
          model: permit.execution.model,
          reasoningEffort: permit.execution.reasoningEffort,
          planModeEnabled: false,
          startupModePreset: 'non_interactive' as const,
        }
      : {}),
    assertCurrent: async () => {
      await authority.assertStartup(id, permit);
      await options.assertCurrent?.();
    },
  };
}
export function pinEventSession(
  session: AgentSessionRecord,
  permit?: EventInitialPermit
): AgentSessionRecord {
  if (!permit) {
    return session;
  }
  if (
    session.provider !== permit.execution.provider ||
    session.codexAccountId !== permit.execution.codexAccountId
  ) {
    throw new Error('Frozen event provider or account changed');
  }
  return {
    ...session,
    model: permit.execution.model,
    providerMetadata: createSessionLaunchMetadata(permit.execution) ?? {},
  };
}
