import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { EventAgentExecution } from '@/shared/event-agent-launch';
import type { EventInitialPermit, EventSessionAuthority } from './event-session-authority';
import { createSessionLaunchMetadata } from './session-launch-settings';

const cleanupIntent = new WeakMap<() => Promise<void>, boolean>();
type GuardedStartup = { eventInitial?: EventInitialPermit; assertCurrent?: () => Promise<void> };
export async function guardEventStartup<T extends GuardedStartup>(
  authority: EventSessionAuthority | undefined,
  id: string,
  options: T
): Promise<T> {
  if (!authority) {
    if (options.eventInitial) {
      throw new Error('Event initial authority is missing');
    }
    return options;
  }
  const permit = options.eventInitial;
  const checkFence = await authority.createStartupGuard(id, permit);
  const assertCurrent = async () => {
    await checkFence();
    await options.assertCurrent?.();
  };
  cleanupIntent.set(assertCurrent, requestsStartupCleanup(options));
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
    assertCurrent,
  };
}
export function requestsStartupCleanup(options?: GuardedStartup): boolean {
  return Boolean(
    options?.eventInitial ||
    (options?.assertCurrent && (cleanupIntent.get(options.assertCurrent) ?? true))
  );
}
export function pinEventSession(
  session: AgentSessionRecord,
  permit?: EventInitialPermit
): AgentSessionRecord {
  return pinEventExecution(session, permit?.execution);
}
export function pinEventExecution(
  session: AgentSessionRecord,
  execution?: EventAgentExecution
): AgentSessionRecord {
  if (!execution) {
    return session;
  }
  if (
    session.provider !== execution.provider ||
    session.codexAccountId !== execution.codexAccountId
  ) {
    throw new Error('Frozen event provider or account changed');
  }
  return {
    ...session,
    model: execution.model,
    providerMetadata: createSessionLaunchMetadata(execution) ?? {},
  };
}
