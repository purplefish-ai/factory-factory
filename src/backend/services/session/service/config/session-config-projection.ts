import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { createLogger } from '@/backend/services/logger.service';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpProcessHandle, AcpRuntimeManager } from '@/backend/services/session/service/acp';
import type { SessionLaunchOptionsService } from '@/backend/services/session/service/config/launch-options/session-launch-options.service';
import type { SessionRepository } from '@/backend/services/session/service/data/session.repository';
import type { CodexModelCatalogService } from '@/backend/services/session/service/providers/codex-model-catalog.service';
import { type ChatBarCapabilities, EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { NATIVE_DEFAULT_CODEX_ACCOUNT_ID } from '@/shared/codex-accounts';
import type { SessionLaunchOptions } from '@/shared/session-launch';
import { parseAcpConfigSnapshot } from './acp-config-snapshot';
import {
  buildCapabilitiesFromConfigOptions,
  buildCodexConfigOptionsWithModelCatalog,
  type CodexModelCatalogEntry,
  type SessionProvider,
} from './session-config-option-helpers';

const logger = createLogger('session');
const MAX_CONFIG_READ_RETIREMENTS = 3;

export type SessionConfigProjection = {
  capabilities: ChatBarCapabilities;
  configOptions: SessionConfigOption[];
};

/** Finalize immediately before publication; after a retirement retry, finalize again without yielding. */
export type ResolvedSessionConfigProjection = {
  currentProjection():
    | SessionConfigProjection
    | { retry: Promise<ResolvedSessionConfigProjection> };
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

export type SessionConfigReadContext = {
  catalog?: Promise<CodexModelCatalogEntry[] | null>;
  retirements: number;
};

/**
 * Read side of session configuration: live runtime options when a runtime owns
 * them, otherwise the stored snapshot enriched with the Codex model catalog.
 */
export class SessionConfigReader {
  constructor(
    private readonly runtimeManager: AcpRuntimeManager,
    private readonly repository: SessionRepository,
    private readonly codexModelCatalogService: Pick<CodexModelCatalogService, 'getModels'>,
    private readonly launchOptionsService: Pick<SessionLaunchOptionsService, 'getOptions'>
  ) {}

  getLaunchOptions(input: {
    provider: SessionProvider;
    model?: string;
    codexAccountId?: string;
  }): Promise<SessionLaunchOptions> {
    return this.launchOptionsService.getOptions(input);
  }

  getSessionConfigOptions(sessionId: string): SessionConfigOption[] {
    const acpHandle = this.runtimeManager.getClient(sessionId);
    return acpHandle ? [...acpHandle.configOptions] : [];
  }

  async getSessionConfigOptionsWithFallback(sessionId: string): Promise<SessionConfigOption[]> {
    let resolved = await this.getSessionConfigProjection(sessionId);
    for (;;) {
      const current = resolved.currentProjection();
      if ('retry' in current) {
        resolved = await current.retry;
        continue;
      }
      return current.configOptions;
    }
  }

  getSessionConfigProjection(sessionId: string): Promise<ResolvedSessionConfigProjection> {
    return this.readSessionConfigProjection(sessionId, { retirements: 0 });
  }

  async getChatBarCapabilities(sessionId: string): Promise<ChatBarCapabilities> {
    const handle = this.runtimeManager.getClient(sessionId);
    if (handle && handle.configOptions.length === 0) {
      return this.buildAcpChatBarCapabilities(handle);
    }
    let resolved = await this.getSessionConfigProjection(sessionId);
    for (;;) {
      const current = resolved.currentProjection();
      if ('retry' in current) {
        resolved = await current.retry;
        continue;
      }
      return current.capabilities;
    }
  }

  buildAcpChatBarCapabilities(handle: AcpProcessHandle): ChatBarCapabilities {
    return buildCapabilitiesFromConfigOptions(
      handle.provider as SessionProvider,
      handle.configOptions
    );
  }

  private async readSessionConfigProjection(
    sessionId: string,
    context: SessionConfigReadContext
  ): Promise<ResolvedSessionConfigProjection> {
    const live = this.runtimeManager.getClient(sessionId);
    if (live && live.configOptions.length > 0) {
      return this.resolveConfigProjection(sessionId, null, context);
    }

    let session = await this.repository.getSessionById(sessionId);
    // A runtime installed during the read owns its options without catalog enrichment.
    const current = this.runtimeManager.getClient(sessionId);
    if (current && current.configOptions.length > 0) {
      return this.resolveConfigProjection(sessionId, null, context);
    }
    let modelCatalog = null;
    if (session?.provider === 'CODEX') {
      context.catalog ??= this.codexModelCatalogService
        .getModels(session.codexAccountId ?? NATIVE_DEFAULT_CODEX_ACCOUNT_ID)
        .catch((error: unknown) => {
          logger.warn('Failed to refresh Codex model catalog from app-server fallback', {
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
      modelCatalog = await context.catalog;
      // Passive discovery must not retain a selection from before a stopped edit.
      session = await this.repository.getSessionById(sessionId);
    }
    return this.resolveConfigProjection(
      sessionId,
      buildStoredConfigProjection(session, modelCatalog),
      context
    );
  }

  private resolveConfigProjection(
    sessionId: string,
    fallback: SessionConfigProjection | null,
    context: SessionConfigReadContext
  ): ResolvedSessionConfigProjection {
    const observedLive = this.runtimeManager.getClient(sessionId);
    const hadLiveOptions = !!observedLive?.configOptions.length;
    let retry: Promise<ResolvedSessionConfigProjection> | undefined;
    const refreshRetired = () => {
      if (!retry) {
        if (context.retirements >= MAX_CONFIG_READ_RETIREMENTS) {
          throw new Error('Session runtime retired repeatedly during configuration read');
        }
        context.retirements += 1;
        retry = this.readSessionConfigProjection(sessionId, context);
      }
      return { retry };
    };
    return {
      currentProjection: () => {
        const handle = this.runtimeManager.getClient(sessionId);
        if (!handle?.configOptions.length && (hadLiveOptions || !fallback)) {
          return refreshRetired();
        }
        if (!handle) {
          if (!fallback) {
            throw new Error('Session configuration requires a durable reread');
          }
          return fallback;
        }
        const configOptions = structuredClone(handle.configOptions);
        return {
          capabilities: buildCapabilitiesFromConfigOptions(
            handle.provider as SessionProvider,
            configOptions
          ),
          // Preserve the existing empty-handle contract: live capabilities, cached options.
          configOptions: configOptions.length > 0 ? configOptions : (fallback?.configOptions ?? []),
        };
      },
    };
  }
}
