import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpProcessHandle } from '@/backend/services/session/service/acp';
import { parseAcpConfigSnapshot } from './acp-config-snapshot';
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
    const active = handle.configOptions.find((o) => o.id === option.id);
    if (!active) {
      throw new Error(`Existing configuration option is unavailable: ${option.id}`);
    }
    if (active.currentValue !== option.currentValue) {
      if (option.category === 'mode' && option.type === 'select') {
        await handle.connection.setSessionMode({
          sessionId: handle.providerSessionId,
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
        sessionId: handle.providerSessionId,
        configId: option.id,
        ...(typeof option.currentValue === 'boolean'
          ? { type: 'boolean' as const, value: option.currentValue }
          : { value: option.currentValue }),
      });
      handle.configOptions = restored.configOptions;
      assertStartupAllowed();
    }
  }
}
