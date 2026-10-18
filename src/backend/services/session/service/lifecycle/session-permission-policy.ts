import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type { AcpProcessHandle, AcpRuntimeManager } from '@/backend/services/session/service/acp';
import { ADVERSARIAL_REVIEW_WORKFLOW } from '@/shared/adversarial-review';
import type { SessionPermissionPreset } from '@prisma-gen/client';
import { getConfigOptionValues } from './session-config-option-helpers';

export function assertReadOnlyReviewConfigOption(
  workflow: string | undefined,
  configId: string,
  value: string,
  option: SessionConfigOption | undefined,
  provider: string
): void {
  if (workflow !== ADVERSARIAL_REVIEW_WORKFLOW) {
    return;
  }
  const mode = configId === 'mode' || option?.category === 'mode';
  const collaboration =
    configId === 'collaboration_mode' || option?.category === 'collaboration_mode';
  if (
    (mode && value !== (provider === 'CODEX' ? 'read-only' : 'plan')) ||
    (collaboration && value !== 'plan')
  ) {
    throw new Error('Adversarial review permissions must remain read-only');
  }
}

// Access and collaboration are independent in Codex. The permission bridge also
// rejects every reviewer approval, preventing escalation from read-only access.
export async function applyReadOnlyReviewPermissions(
  sessionId: string,
  handle: AcpProcessHandle,
  runtime: Pick<AcpRuntimeManager, 'setSessionMode' | 'setConfigOption'>
): Promise<boolean> {
  const mode = handle.configOptions.find(
    (option) => option.id === 'mode' || option.category === 'mode'
  );
  const target = handle.provider === 'CODEX' ? 'read-only' : 'plan';
  if (!(mode && getConfigOptionValues(mode).includes(target))) {
    throw new Error(`Adversarial review requires ${target} mode`);
  }
  let didUpdate = false;
  if (mode.currentValue !== target) {
    handle.configOptions = await runtime.setSessionMode(sessionId, target);
    didUpdate = true;
  }
  if (handle.configOptions.find((option) => option.id === mode.id)?.currentValue !== target) {
    throw new Error('Adversarial review read-only mode was not applied');
  }
  if (handle.provider === 'CODEX') {
    const collaboration = handle.configOptions.find((option) => option.id === 'collaboration_mode');
    if (!(collaboration && getConfigOptionValues(collaboration).includes('plan'))) {
      throw new Error('Adversarial review requires plan collaboration mode');
    }
    if (collaboration.currentValue !== 'plan') {
      handle.configOptions = await runtime.setConfigOption(sessionId, collaboration.id, 'plan');
      didUpdate = true;
    }
    if (
      handle.configOptions.find((option) => option.id === collaboration.id)?.currentValue !== 'plan'
    ) {
      throw new Error('Adversarial review plan collaboration mode was not applied');
    }
    if (handle.configOptions.find((option) => option.id === mode.id)?.currentValue !== target) {
      throw new Error('Adversarial review read-only mode was not applied');
    }
  }
  return didUpdate;
}

export function resolveConfiguredAccessModeTarget(
  provider: string,
  modeOption: SessionConfigOption,
  permissionPreset: SessionPermissionPreset
): string | null {
  const targets =
    provider === 'CODEX'
      ? { STRICT: 'workspace-write', RELAXED: 'agent', YOLO: 'agent-full-access' }
      : { STRICT: 'default', RELAXED: 'acceptEdits', YOLO: 'bypassPermissions' };
  const target = targets[permissionPreset];
  return getConfigOptionValues(modeOption).includes(target) ? target : null;
}
