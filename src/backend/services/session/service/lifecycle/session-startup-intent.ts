import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { SessionLaunchSettings } from '@/shared/session-launch';
import { readSessionLaunchSettings } from './session-launch-settings';

/** Desired fields only: unrelated metadata and observed-state generations are not intent. */
export type SessionStartupIntent = {
  model: string;
  confirmedModel?: string;
  launch: ReturnType<typeof readSessionLaunchSettings>;
  overrides?: SessionLaunchSettings;
};

export class SessionStartupIntentChangedError extends Error {
  constructor() {
    super('Session startup intent changed before acknowledgment');
  }
}

export function captureSessionStartupIntent(session: AgentSessionRecord): SessionStartupIntent {
  return { model: session.model, launch: readSessionLaunchSettings(session.providerMetadata) };
}

export function matchesSessionStartupIntent(
  session: AgentSessionRecord,
  expected: SessionStartupIntent
): boolean {
  const current = readSessionLaunchSettings(session.providerMetadata);
  return (
    (session.model === expected.model || session.model === expected.confirmedModel) &&
    (expected.overrides?.reasoningEffort !== undefined ||
      current?.reasoningEffort === expected.launch?.reasoningEffort) &&
    (expected.overrides?.planModeEnabled !== undefined ||
      current?.planModeEnabled === expected.launch?.planModeEnabled)
  );
}

export function canAcknowledgeSessionLaunch(
  current: ReturnType<typeof readSessionLaunchSettings>,
  expected: SessionStartupIntent
): boolean {
  return (
    !current ||
    ((current.reasoningEffort === undefined ||
      expected.overrides?.reasoningEffort === undefined ||
      current.reasoningEffort === expected.overrides.reasoningEffort) &&
      (current.planModeEnabled === undefined ||
        expected.overrides?.planModeEnabled === undefined ||
        current.planModeEnabled === expected.overrides.planModeEnabled))
  );
}
