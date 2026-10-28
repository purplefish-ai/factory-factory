import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { createLogger } from '@/backend/services/logger.service';
import type { AcpProcessHandle, AcpRuntimeManager } from '@/backend/services/session/service/acp';
import {
  findModeValue,
  getConfigOptionValues,
  type SessionProvider,
} from './session-config-option-helpers';

const logger = createLogger('session');
type StartupModePreset = 'non_interactive' | 'plan';

export async function applyStartupCollaborationModePreset(
  runtime: Pick<AcpRuntimeManager, 'setSessionMode' | 'setConfigOption'>,
  params: {
    sessionId: string;
    handle: AcpProcessHandle;
    startupModePreset: StartupModePreset;
    workflow: string;
  },
  confirmTarget: (id: string, value: string) => void
): Promise<boolean> {
  const modeOption = findCollaborationOption(params.handle.provider, params.handle.configOptions);
  if (!modeOption) {
    return false;
  }
  const availableModeValues = getConfigOptionValues(modeOption);
  const targetMode = resolveStartupModeTarget(
    params.handle.provider as SessionProvider,
    params.startupModePreset,
    availableModeValues
  );
  if (!targetMode) {
    logger.debug('Startup mode preset not available in ACP mode options', {
      sessionId: params.sessionId,
      provider: params.handle.provider,
      workflow: params.workflow,
      startupModePreset: params.startupModePreset,
      availableModeValues,
    });
    return false;
  }
  if (modeOption.currentValue === targetMode) {
    confirmTarget(modeOption.id, targetMode);
    return false;
  }
  let didUpdate = false;
  try {
    await (modeOption.id === 'mode'
      ? runtime.setSessionMode(params.sessionId, targetMode)
      : runtime.setConfigOption(params.sessionId, modeOption.id, targetMode));
    didUpdate = true;
  } catch (error) {
    logger.warn('Failed applying startup mode preset', {
      sessionId: params.sessionId,
      provider: params.handle.provider,
      workflow: params.workflow,
      startupModePreset: params.startupModePreset,
      targetMode,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // The explicit request authorizes only this target, even if its notification
  // arrived before an optional RPC error. The policy checks the current handle.
  confirmTarget(modeOption.id, targetMode);
  return didUpdate;
}

export function findCollaborationOption(provider: string, configOptions: SessionConfigOption[]) {
  return configOptions.find((option) =>
    provider === 'CODEX'
      ? option.id === 'collaboration_mode' || option.category === 'collaboration_mode'
      : option.id === 'mode' || option.category === 'mode'
  );
}

export function resolveStartupModeTarget(
  provider: SessionProvider,
  startupModePreset: StartupModePreset,
  availableModeValues: string[]
): string | null {
  if (availableModeValues.length === 0) {
    return null;
  }
  if (startupModePreset === 'plan') {
    return findModeValue(availableModeValues, ['plan']);
  }
  if (provider === 'CLAUDE') {
    return findModeValue(availableModeValues, [
      'bypassPermissions',
      'dangerouslySkipPermissions',
      'dangerousSkipPermissions',
      'acceptEdits',
    ]);
  }
  return findModeValue(availableModeValues, ['default']);
}
