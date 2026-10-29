import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import type { AcpProcessHandle, AcpRuntimeManager } from '@/backend/services/session/service/acp';
import { ADVERSARIAL_REVIEW_WORKFLOW } from '@/shared/adversarial-review';
import type { SessionPermissionPreset } from '@prisma-gen/client';
import { parseAcpConfigSnapshot } from './acp-config-snapshot';
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
    await runtime.setSessionMode(sessionId, target);
    didUpdate = true;
  }
  if (handle.configOptions.find((option) => option.id === mode.id)?.currentValue !== target) {
    throw new Error('Adversarial review read-only mode was not applied');
  }
  if (handle.provider === 'CODEX') {
    const collaboration = handle.configOptions.find(
      (option) => option.id === 'collaboration_mode' || option.category === 'collaboration_mode'
    );
    if (!(collaboration && getConfigOptionValues(collaboration).includes('plan'))) {
      throw new Error('Adversarial review requires plan collaboration mode');
    }
    if (collaboration.currentValue !== 'plan') {
      await runtime.setConfigOption(sessionId, collaboration.id, 'plan');
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

// Presets name the adapters' shared mode kinds: standard, auto review, full access.
const ACCESS_MODE_TARGETS: Record<'CLAUDE' | 'CODEX', Record<SessionPermissionPreset, string>> = {
  CODEX: { STRICT: 'workspace-write', RELAXED: 'agent', YOLO: 'agent-full-access' },
  CLAUDE: { STRICT: 'default', RELAXED: 'auto', YOLO: 'bypassPermissions' },
};

// Claude's adapter applies Accept edits when the selected model lacks Auto mode.
const CLAUDE_AUTO_FALLBACK = 'acceptEdits';

export function resolveConfiguredAccessModeTarget(
  provider: string,
  modeOption: SessionConfigOption,
  permissionPreset: SessionPermissionPreset
): string | null {
  const target = ACCESS_MODE_TARGETS[provider === 'CODEX' ? 'CODEX' : 'CLAUDE'][permissionPreset];
  const values = getConfigOptionValues(modeOption);
  if (values.includes(target)) {
    return target;
  }
  return provider === 'CLAUDE' && target === 'auto' && values.includes(CLAUDE_AUTO_FALLBACK)
    ? CLAUDE_AUTO_FALLBACK
    : null;
}

/** Whether the adapter's current mode satisfies a requested access target. */
export function isAppliedAccessMode(
  provider: string,
  target: string,
  current: unknown
): current is string {
  return (
    current === target ||
    (provider === 'CLAUDE' && target === 'auto' && current === CLAUDE_AUTO_FALLBACK)
  );
}

export class SessionStartupTargetError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
  }
}

export class SessionStartupPermissionError extends Error {
  constructor() {
    super('Configured session access mode was not applied');
  }
}

/** Startup remembers required access; provider observations cannot silently broaden it. */
export class SessionStartupPermissions {
  private readonly required = new WeakMap<AcpProcessHandle, { id: string; value: unknown }[]>();

  capture(
    handle: AcpProcessHandle,
    source: Pick<SessionConfigOption, 'id' | 'category' | 'currentValue'>[] = handle.configOptions,
    includePlanning = false
  ): void {
    const modes = source.filter(
      (option) =>
        option.id === 'mode' ||
        option.category === 'mode' ||
        (includePlanning &&
          (option.id === 'collaboration_mode' || option.category === 'collaboration_mode'))
    );
    this.required.set(handle, [
      ...(this.required.get(handle) ?? []).filter(
        (expected) => !modes.some((mode) => mode.id === expected.id)
      ),
      ...modes.map((option) => ({ id: option.id, value: option.currentValue })),
    ]);
  }

  captureReview(handle: AcpProcessHandle): void {
    this.capture(
      handle,
      handle.configOptions.map((option) => {
        if (option.id === 'mode' || option.category === 'mode') {
          return { ...option, currentValue: handle.provider === 'CODEX' ? 'read-only' : 'plan' };
        }
        if (option.id === 'collaboration_mode' || option.category === 'collaboration_mode') {
          return { ...option, currentValue: 'plan' };
        }
        return option;
      }),
      true
    );
  }

  expectAccess(handle: AcpProcessHandle, id: string, value: string): void {
    const current = handle.configOptions.find((option) => option.id === id)?.currentValue;
    if (!isAppliedAccessMode(handle.provider, value, current)) {
      throw new SessionStartupPermissionError();
    }
    this.capture(handle);
  }

  authorizeRequestedTarget(handle: AcpProcessHandle, id: string, value: string): void {
    // Claude planning and access share one native control. Only the exact requested,
    // confirmed target can replace its prior requirement; unrelated observations cannot.
    if (
      handle.provider !== 'CLAUDE' ||
      handle.configOptions.find((option) => option.id === id)?.currentValue !== value
    ) {
      return;
    }
    const required = this.required.get(handle) ?? [];
    this.required.set(handle, [...required.filter((option) => option.id !== id), { id, value }]);
  }

  expectLaunchTarget(handle: AcpProcessHandle, id: string, value: string): void {
    if (handle.configOptions.find((option) => option.id === id)?.currentValue !== value) {
      throw new SessionStartupTargetError(
        new Error('Requested startup configuration was not applied')
      );
    }
    const required = this.required.get(handle) ?? [];
    this.required.set(handle, [...required.filter((option) => option.id !== id), { id, value }]);
  }

  assertCurrent(handle: AcpProcessHandle, storedMetadata?: unknown): void {
    // Strict PR restoration skips current defaults; its validated saved access remains required.
    if (!this.required.has(handle)) {
      const saved = parseAcpConfigSnapshot(storedMetadata);
      if (saved) {
        this.capture(handle, saved.configOptions);
      }
    }
    for (const expected of this.required.get(handle) ?? []) {
      if (
        handle.configOptions.find((option) => option.id === expected.id)?.currentValue !==
        expected.value
      ) {
        throw new SessionStartupPermissionError();
      }
    }
  }
}
