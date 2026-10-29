import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpProcessHandle, AcpRuntimeManager } from '@/backend/services/session/service/acp';
import { isNativeModeConfigOption } from '@/backend/services/session/service/acp/acp-config-option-identification';
import { ADVERSARIAL_REVIEW_WORKFLOW } from '@/shared/adversarial-review';
import { getConfigOptionValues } from './session-config-option-helpers';
import { readSessionLaunchSettings } from './session-launch-settings';
import { isAppliedAccessMode } from './session-permission-policy';

/** Initial access intent supersedes intermediate snapshots, but never later confirmed edits. */
export async function applyStartupLaunchAccess(
  sessionId: string,
  session: AgentSessionRecord,
  handle: AcpProcessHandle,
  runtime: Pick<AcpRuntimeManager, 'setSessionMode'>,
  planModeEnabled: boolean | undefined,
  confirmation?: { assertCurrent(): void; confirmTarget(id: string, value: string): void }
): Promise<void> {
  const launch = readSessionLaunchSettings(session.providerMetadata);
  if (!launch || launch.applied || launch.accessMode === undefined) {
    return;
  }
  if (session.workflow === ADVERSARIAL_REVIEW_WORKFLOW) {
    throw new Error('Adversarial review permissions must remain read-only');
  }
  const target = launch.accessMode;
  const option = handle.configOptions.find((entry) => isNativeModeConfigOption(entry, 'mode'));
  if (!option || target === 'plan' || !getConfigOptionValues(option).includes(target)) {
    throw new Error('Requested access mode is unavailable for the selected provider/model');
  }
  confirmation?.assertCurrent();
  // Explicit Claude Plan is the final native mode; avoid first granting access
  // that the next startup step would immediately replace with read-only Plan.
  if (handle.provider === 'CLAUDE' && planModeEnabled === true) {
    return;
  }
  // Claude access and planning share one mode; retain established read-only Plan
  // authority unless launch explicitly turns planning off.
  if (handle.provider === 'CLAUDE' && option.currentValue === 'plan' && planModeEnabled !== false) {
    confirmation?.confirmTarget(option.id, 'plan');
    return;
  }
  if (option.currentValue !== target) {
    await runtime.setSessionMode(sessionId, target);
  }
  confirmation?.assertCurrent();
  const applied = handle.configOptions.find((entry) => entry.id === option.id)?.currentValue;
  if (!isAppliedAccessMode(handle.provider, target, applied)) {
    throw new Error('Requested access mode was not applied');
  }
  confirmation?.confirmTarget(option.id, String(applied));
}
