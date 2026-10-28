import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import { type ChatBarCapabilities, EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { parseAcpConfigSnapshot } from './acp-config-snapshot';
import {
  buildCapabilitiesFromConfigOptions,
  buildCodexConfigOptionsWithModelCatalog,
  type CodexModelCatalogEntry,
} from './session-config-option-helpers';

export type SessionConfigProjection = {
  capabilities: ChatBarCapabilities;
  configOptions: SessionConfigOption[];
};

/** Finalize synchronously immediately before publishing the paired load events. */
export type ResolvedSessionConfigProjection = {
  currentProjection(): SessionConfigProjection;
};

/** Pure display selection from the final stored row; never confirms or persists a model. */
export function buildStoredConfigProjection(
  session: Pick<AgentSessionRecord, 'provider' | 'providerMetadata' | 'model'> | null,
  modelCatalog: CodexModelCatalogEntry[] | null
): SessionConfigProjection {
  const snapshot = parseAcpConfigSnapshot(session?.providerMetadata);
  const validSnapshot = snapshot?.provider === session?.provider ? snapshot : null;
  let configOptions = structuredClone(validSnapshot?.configOptions ?? []);
  if (session?.provider === 'CODEX' && modelCatalog?.length) {
    configOptions = buildCodexConfigOptionsWithModelCatalog(
      configOptions,
      modelCatalog,
      session.model
    );
  }
  const capabilities =
    session && (configOptions.length > 0 || validSnapshot?.provider === 'CLAUDE')
      ? buildCapabilitiesFromConfigOptions(
          session.provider,
          configOptions,
          validSnapshot?.observedModelId ??
            (session.provider === 'CODEX' ? session.model : undefined)
        )
      : {
          ...EMPTY_CHAT_BAR_CAPABILITIES,
          ...(session?.provider === 'CODEX' ? { provider: 'CODEX' as const } : {}),
        };
  return { capabilities, configOptions };
}
