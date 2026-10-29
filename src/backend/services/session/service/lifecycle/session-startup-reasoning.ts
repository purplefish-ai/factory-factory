import { createLogger } from '@/backend/services/logger.service';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpProcessHandle } from '@/backend/services/session/service/acp';
import { isReasoningConfigOption } from '@/backend/services/session/service/acp/acp-config-option-identification';
import { userSettingsService } from '@/backend/services/settings';
import { parseAcpConfigSnapshot } from './acp-config-snapshot';
import type { SessionProvider } from './session-config-option-helpers';
import { readSessionLaunchSettings } from './session-launch-settings';
const logger = createLogger('session');
export async function configuredReasoningEffort(
  sessionId: string,
  provider: SessionProvider
): Promise<string | null> {
  try {
    const settings = await userSettingsService.get();
    const value =
      provider === 'CLAUDE'
        ? settings.defaultClaudeReasoningEffort
        : settings.defaultCodexReasoningEffort;
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  } catch (error) {
    logger.warn('Failed loading user reasoning-effort defaults; using provider default', {
      sessionId,
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
export async function startupReasoningTarget(
  sessionId: string,
  handle: AcpProcessHandle,
  session?: AgentSessionRecord,
  override?: string | null
): Promise<{ value: string | null; strict: boolean; normalizeUnsupported?: boolean }> {
  if (override !== undefined) {
    return { value: override, strict: true };
  }
  const launch = readSessionLaunchSettings(session?.providerMetadata);
  if (launch && !launch.applied && launch.reasoningEffort !== undefined) {
    return { value: launch.reasoningEffort, strict: true };
  }
  if (session && (!launch || launch.applied)) {
    const saved = savedReasoningTarget(session, handle, launch?.applied === true);
    if (saved) {
      return saved;
    }
  }
  return {
    value: await configuredReasoningEffort(sessionId, handle.provider as SessionProvider),
    strict: false,
  };
}

function savedReasoningTarget(
  session: AgentSessionRecord,
  handle: AcpProcessHandle,
  requireSnapshot: boolean
): { value: string | null; strict: boolean; normalizeUnsupported?: boolean } | undefined {
  const snapshot = parseAcpConfigSnapshot(session.providerMetadata);
  if (!snapshot) {
    if (requireSnapshot) {
      throw new Error('Saved reasoning configuration is missing or invalid');
    }
    return undefined;
  }
  const identity =
    handle.providerSessionId !== session.providerSessionId &&
    handle.sessionCreationOutcome.kind === 'resume_fallback'
      ? handle.sessionCreationOutcome.previousProviderSessionId
      : handle.providerSessionId;
  if (
    snapshot.provider !== session.provider ||
    snapshot.providerSessionId !== session.providerSessionId ||
    identity !== session.providerSessionId
  ) {
    throw new Error('Saved reasoning configuration belongs to another conversation');
  }
  const saved = snapshot.configOptions.find(isReasoningConfigOption);
  return {
    value: saved?.type === 'select' ? saved.currentValue : null,
    strict: true,
    normalizeUnsupported: true,
  };
}
