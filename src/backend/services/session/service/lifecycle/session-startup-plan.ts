import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpProcessHandle, AcpRuntimeManager } from '@/backend/services/session/service/acp';
import { isNativeModeConfigOption } from '@/backend/services/session/service/acp/acp-config-option-identification';
import { ADVERSARIAL_REVIEW_WORKFLOW } from '@/shared/adversarial-review';
import type { SessionPermissionPreset } from '@prisma-gen/client';
import { getConfigOptionValues } from './session-config-option-helpers';
import { readSessionLaunchSettings } from './session-launch-settings';
import {
  isAppliedAccessMode,
  resolveConfiguredAccessModeTarget,
} from './session-permission-policy';
export async function applyStartupLaunchPlan(
  sessionId: string,
  session: AgentSessionRecord,
  handle: AcpProcessHandle,
  preset: SessionPermissionPreset | undefined,
  runtime: Pick<AcpRuntimeManager, 'setSessionMode' | 'setConfigOption'>,
  override?: boolean,
  resolvePreset?: () => Promise<SessionPermissionPreset>,
  confirmation?: { assertCurrent(): void; confirmTarget(id: string, value: string): void }
): Promise<void> {
  const launch = readSessionLaunchSettings(session.providerMetadata);
  const enabled = override ?? (launch && !launch.applied ? launch.planModeEnabled : undefined);
  if (enabled === undefined) {
    return;
  }
  if (session.workflow === ADVERSARIAL_REVIEW_WORKFLOW && !enabled) {
    throw new Error('Adversarial review permissions must remain read-only');
  }
  const option = handle.configOptions.find((entry) =>
    isNativeModeConfigOption(entry, handle.provider === 'CLAUDE' ? 'mode' : 'collaboration_mode')
  );
  if (option?.type !== 'select') {
    if (enabled) {
      throw new Error('Plan mode is unavailable for the selected provider/model');
    }
    return;
  }
  const target = await requestedPlanMode(handle.provider, enabled, option, preset, resolvePreset);
  if (!getConfigOptionValues(option).includes(target)) {
    throw new Error('Requested Plan mode is unavailable for the selected provider/model');
  }
  confirmation?.assertCurrent();
  if (handle.configOptions.find((entry) => entry.id === option.id)?.currentValue !== target) {
    await (handle.provider === 'CLAUDE'
      ? runtime.setSessionMode(sessionId, target)
      : runtime.setConfigOption(sessionId, option.id, target));
  }
  confirmation?.assertCurrent();
  const applied = handle.configOptions.find((entry) => entry.id === option.id)?.currentValue;
  if (!isAppliedAccessMode(handle.provider, target, applied)) {
    throw new Error('Requested Plan mode was not applied');
  }
  confirmation?.confirmTarget(option.id, String(applied));
}

async function requestedPlanMode(
  provider: string,
  enabled: boolean,
  option: SessionConfigOption,
  preset: SessionPermissionPreset | undefined,
  resolvePreset?: () => Promise<SessionPermissionPreset>
): Promise<string> {
  if (enabled) {
    return 'plan';
  }
  if (provider === 'CODEX') {
    return 'default';
  }
  // Permissions were configured/restored before this step; preserve an explicit non-Plan ACL.
  if (option.currentValue !== 'plan') {
    return String(option.currentValue);
  }
  const effectivePreset = preset ?? (await resolvePreset?.());
  const target = effectivePreset
    ? resolveConfiguredAccessModeTarget(provider, option, effectivePreset)
    : undefined;
  if (!target) {
    throw new Error('Configured access mode is unavailable for Plan off');
  }
  return target;
}
