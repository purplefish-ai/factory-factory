import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type { SessionPermissionPreset } from '@prisma-gen/client';
import type { AcpProcessHandle, AcpRuntimeManager } from '@/backend/services/session/service/acp';
import { ADVERSARIAL_REVIEW_WORKFLOW } from '@/shared/adversarial-review';
import { getConfigOptionValues, getSelectOptions } from './session-config-option-helpers';

export function assertReadOnlyReviewConfigOption(
  workflow: string | undefined,
  configId: string,
  value: string,
  option: SessionConfigOption | undefined
): void {
  if (workflow !== ADVERSARIAL_REVIEW_WORKFLOW) {
    return;
  }
  const mode = configId === 'mode' || option?.category === 'mode';
  const permission = configId === 'execution_mode' || option?.category === 'permission';
  if (
    (mode && !findModeValue([value], ['plan'])) ||
    (permission && !findModeValue([value], ['["never","read-only"]']))
  ) {
    throw new Error('Adversarial review permissions must remain read-only');
  }
}

// Collaboration mode and execution permissions are independent in Codex.
// Review turns must never escape the read-only sandbox through an approval.
export async function applyReadOnlyReviewPermissions(
  sessionId: string,
  handle: AcpProcessHandle,
  runtime: Pick<AcpRuntimeManager, 'setSessionMode' | 'setConfigOption'>
): Promise<boolean> {
  let didUpdate = false;
  const mode = handle.configOptions.find((option) => option.category === 'mode');
  const planValue = mode && findModeValue(getConfigOptionValues(mode), ['plan']);
  if (!(mode && planValue)) {
    throw new Error('Adversarial review requires plan mode');
  }
  if (mode.currentValue !== planValue) {
    handle.configOptions = await runtime.setSessionMode(sessionId, planValue);
    didUpdate = true;
  }
  if (handle.configOptions.find((option) => option.id === mode.id)?.currentValue !== planValue) {
    throw new Error('Adversarial review plan mode was not applied');
  }
  if (handle.provider !== 'CODEX') {
    return didUpdate;
  }

  const execution = handle.configOptions.find(
    (option) => option.id === 'execution_mode' || option.category === 'permission'
  );
  const readOnlyValue =
    execution && findModeValue(getConfigOptionValues(execution), ['["never","read-only"]']);
  if (!(execution && readOnlyValue)) {
    throw new Error('Adversarial review requires read-only execution without approval escalation');
  }
  if (execution.currentValue !== readOnlyValue) {
    handle.configOptions = await runtime.setConfigOption(sessionId, execution.id, readOnlyValue);
    didUpdate = true;
  }
  if (
    handle.configOptions.find((option) => option.id === execution.id)?.currentValue !==
    readOnlyValue
  ) {
    throw new Error('Adversarial review read-only execution was not applied');
  }
  return didUpdate;
}

export function resolveConfiguredExecutionModeTarget(
  executionModeOption: SessionConfigOption,
  permissionPreset: SessionPermissionPreset
): string | null {
  const availableValues = getConfigOptionValues(executionModeOption);
  const preferredValuesByPreset: Record<SessionPermissionPreset, string[]> = {
    STRICT: [
      '["on-request","workspace-write"]',
      '["on-request","read-only"]',
      '["on-request","danger-full-access"]',
    ],
    RELAXED: [
      '["on-failure","workspace-write"]',
      '["on-failure","read-only"]',
      '["on-failure","danger-full-access"]',
    ],
    YOLO: [
      '["never","danger-full-access"]',
      '["never","workspace-write"]',
      '["never","read-only"]',
    ],
  };
  const preferredValues = preferredValuesByPreset[permissionPreset];
  const byValue = findModeValue(availableValues, preferredValues);
  if (byValue) {
    return byValue;
  }

  const byName = getSelectOptions(executionModeOption).find((option) => {
    const name = option.name ?? '';
    if (permissionPreset === 'STRICT') {
      return /on request/i.test(name);
    }
    if (permissionPreset === 'RELAXED') {
      return /on failure/i.test(name);
    }
    return /yolo|never ask/i.test(name);
  });
  return byName?.value ?? null;
}

function findModeValue(
  availableModeValues: string[],
  preferredModeValues: string[]
): string | null {
  if (availableModeValues.length === 0 || preferredModeValues.length === 0) {
    return null;
  }

  const availableByNormalized = new Map<string, string>();
  for (const value of availableModeValues) {
    availableByNormalized.set(value.replace(/[^a-z0-9]/gi, '').toLowerCase(), value);
  }

  for (const preferredValue of preferredModeValues) {
    const match = availableByNormalized.get(
      preferredValue.replace(/[^a-z0-9]/gi, '').toLowerCase()
    );
    if (match) {
      return match;
    }
  }

  return null;
}
