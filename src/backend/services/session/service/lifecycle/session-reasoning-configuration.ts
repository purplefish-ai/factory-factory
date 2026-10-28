import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { createLogger } from '@/backend/services/logger.service';
import type { AcpProcessHandle, AcpRuntimeManager } from '@/backend/services/session/service/acp';
import { isReasoningConfigOption } from '@/backend/services/session/service/acp/acp-config-option-identification';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { SessionDeltaEvent } from '@/shared/acp-protocol';
import {
  buildCapabilitiesFromConfigOptions,
  getConfigOptionValues,
  type SessionProvider,
} from './session-config-option-helpers';
const logger = createLogger('session');
export type ReasoningEffortTargetParams = {
  sessionId: string;
  handle: AcpProcessHandle;
  targetReasoningEffort: string;
  source: 'message' | 'settings';
  strict?: boolean;
  normalizeUnsupported?: boolean;
  persistSnapshot?: boolean;
  emitUpdates?: boolean;
  assertCurrent?: () => void;
};
type Dependencies = {
  runtimeManager: Pick<AcpRuntimeManager, 'setConfigOption'>;
  persistSnapshot(
    sessionId: string,
    params: {
      provider: SessionProvider;
      providerSessionId: string;
      configOptions: SessionConfigOption[];
      assertCurrent?: () => void;
    }
  ): Promise<void>;
  emitDelta: SessionDomainService['emitDelta'];
};
export async function applyReasoningEffortTarget(
  params: ReasoningEffortTargetParams,
  deps: Dependencies
): Promise<void> {
  const reasoningOption = supportedReasoningOption(params);
  if (!reasoningOption) {
    return;
  }
  const currentReasoningEffort = reasoningOption.currentValue
    ? String(reasoningOption.currentValue)
    : null;
  if (currentReasoningEffort === params.targetReasoningEffort) {
    return;
  }

  const configOptions = await deps.runtimeManager.setConfigOption(
    params.sessionId,
    reasoningOption.id,
    params.targetReasoningEffort
  );
  params.assertCurrent?.();
  if (
    params.strict &&
    configOptions.find((option) => option.id === reasoningOption.id)?.currentValue !==
      params.targetReasoningEffort
  ) {
    throw new Error('Requested reasoning effort was not applied');
  }
  params.handle.configOptions = configOptions;
  if (params.persistSnapshot !== false) {
    await deps.persistSnapshot(params.sessionId, {
      provider: params.handle.provider as SessionProvider,
      providerSessionId: params.handle.providerSessionId,
      configOptions,
      assertCurrent: params.assertCurrent,
    });
  }
  params.assertCurrent?.();
  if (params.emitUpdates !== false) {
    deps.emitDelta(params.sessionId, {
      type: 'config_options_update',
      configOptions,
    } as SessionDeltaEvent);
    deps.emitDelta(params.sessionId, {
      type: 'chat_capabilities',
      capabilities: buildCapabilitiesFromConfigOptions(
        params.handle.provider as SessionProvider,
        params.handle.configOptions
      ),
    });
  }
}

function supportedReasoningOption(
  params: ReasoningEffortTargetParams
): SessionConfigOption | undefined {
  const reasoningOption = params.handle.configOptions.find(isReasoningConfigOption);
  if (!reasoningOption) {
    if (params.strict && !params.normalizeUnsupported) {
      throw new Error('Unsupported reasoning effort: selected model has no thinking control');
    }
    logger.debug('Skipping reasoning-effort default because provider has no effort option', {
      sessionId: params.sessionId,
      provider: params.handle.provider,
      source: params.source,
    });
    return undefined;
  }

  const availableValues = getConfigOptionValues(reasoningOption);
  if (
    (params.strict || availableValues.length > 0) &&
    !availableValues.includes(params.targetReasoningEffort)
  ) {
    if (params.strict && !params.normalizeUnsupported) {
      throw new Error(`Unsupported reasoning effort: ${params.targetReasoningEffort}`);
    }
    logger.debug('Skipping unsupported reasoning effort for ACP session', {
      sessionId: params.sessionId,
      provider: params.handle.provider,
      reasoningEffort: params.targetReasoningEffort,
      availableValues,
      source: params.source,
    });
    return undefined;
  }

  return reasoningOption;
}
