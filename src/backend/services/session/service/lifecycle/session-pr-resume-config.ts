import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpProcessHandle } from '@/backend/services/session/service/acp';
import { parseAcpConfigSnapshot } from './acp-config-snapshot';
import { getConfigOptionValues } from './session-config-option-helpers';
export async function restorePRResumeConfig(
  session: AgentSessionRecord,
  handle: AcpProcessHandle,
  assertStartupAllowed: () => void
) {
  const snapshot = parseAcpConfigSnapshot(session.providerMetadata);
  if (
    !snapshot ||
    snapshot.provider !== session.provider ||
    snapshot.providerSessionId !== session.providerSessionId
  ) {
    throw new Error('Missing existing ACP configuration for PR monitoring');
  }
  for (const option of snapshot.configOptions) {
    const active = requireAvailableOption(handle.configOptions, option);
    if (active.currentValue !== option.currentValue) {
      if (option.category === 'mode' && option.type === 'select') {
        await handle.connection.setSessionMode({
          sessionId: handle.acpSessionId,
          modeId: option.currentValue,
        });
        handle.configOptions = handle.configOptions.map((cached) =>
          cached.type === 'select' && cached.id === option.id
            ? { ...cached, currentValue: option.currentValue }
            : cached
        );
        assertStartupAllowed();
        continue;
      }
      const restored = await handle.connection.setSessionConfigOption({
        sessionId: handle.acpSessionId,
        configId: option.id,
        ...(typeof option.currentValue === 'boolean'
          ? { type: 'boolean' as const, value: option.currentValue }
          : { value: option.currentValue }),
      });
      handle.configOptions = restored.configOptions;
      assertStartupAllowed();
    }
  }
  for (const option of snapshot.configOptions) {
    if (
      handle.configOptions.find((active) => active.id === option.id)?.currentValue !==
      option.currentValue
    ) {
      throw new Error(`Existing configuration option was not applied: ${option.id}`);
    }
  }
}

function requireAvailableOption(configOptions: SessionConfigOption[], saved: SessionConfigOption) {
  const active = configOptions.find((option) => option.id === saved.id);
  if (
    !active ||
    active.type !== saved.type ||
    (saved.type === 'select' && !getConfigOptionValues(active).includes(saved.currentValue))
  ) {
    throw new Error(`Existing configuration option is unavailable: ${saved.id}`);
  }
  return active;
}
