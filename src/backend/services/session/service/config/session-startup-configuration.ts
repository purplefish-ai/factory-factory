import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { createLogger } from '@/backend/services/logger.service';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpProcessHandle, AcpRuntimeManager } from '@/backend/services/session/service/acp';
import { isNativeModeConfigOption } from '@/backend/services/session/service/acp/acp-config-option-identification';
import {
  confirmsAcpModelSelection,
  resolveAcpModelSelection,
} from '@/backend/services/session/service/acp/acp-model-selection';
import { readSessionLaunchSettings } from '@/backend/services/session/service/data/session-launch-settings';
import type { SessionRepository } from '@/backend/services/session/service/data/session.repository';
import { ADVERSARIAL_REVIEW_WORKFLOW } from '@/shared/adversarial-review';
import type { SessionPermissionPreset } from '@prisma-gen/client';
import { parseAcpConfigSnapshot } from './acp-config-snapshot';
import { getConfigOptionValues, type SessionProvider } from './session-config-option-helpers';
import type { PersistAcpConfigSnapshotParams } from './session-config-snapshot-persistence';
import type { SessionConfigWriter } from './session-config-writer';
import {
  applyReadOnlyReviewPermissions,
  isAppliedAccessMode,
  resolveConfiguredAccessModeTarget,
  SessionStartupPermissions,
  SessionStartupTargetError,
} from './session-permission-policy';
import { restoreSavedNativeModes } from './session-saved-native-modes';
import { applyStartupLaunchAccess } from './session-startup-access';
import {
  SessionStartupConfigurationFinalizer,
  type CompleteStartupConfigurationParams,
} from './session-startup-configuration-finalizer';
import { applyStartupCollaborationModePreset } from './session-startup-mode-preset';
import { startupReasoningTarget } from './session-startup-reasoning';
import { resolvePermissionPresetFromSettings } from './session-workflow-permission-settings';

const logger = createLogger('session');

type SessionStartupModePreset = 'non_interactive' | 'plan';

/**
 * Applies launch intent, permissions, model, mode and reasoning to a new
 * runtime, then confirms the final startup snapshot. Owns the startup
 * permission expectations those steps record.
 */
export class SessionStartupConfiguration {
  private readonly startupPermissions = new SessionStartupPermissions();
  private readonly finalizer: SessionStartupConfigurationFinalizer;

  constructor(
    private readonly runtimeManager: AcpRuntimeManager,
    repository: SessionRepository,
    private readonly writer: SessionConfigWriter
  ) {
    this.finalizer = new SessionStartupConfigurationFinalizer(
      writer.snapshots,
      writer.authority,
      this.startupPermissions,
      repository
    );
  }

  requireSavedStartupAccess(handle: AcpProcessHandle, metadata: unknown): void {
    const snapshot = parseAcpConfigSnapshot(metadata);
    if (
      snapshot?.provider === handle.provider &&
      snapshot.providerSessionId === handle.providerSessionId
    ) {
      this.startupPermissions.capture(handle, snapshot.configOptions);
    }
  }

  async applyStartupModel(
    sessionId: string,
    handle: AcpProcessHandle,
    model: string
  ): Promise<void> {
    const assertCurrent = this.writer.acceptRuntime(sessionId, handle);
    const target = resolveAcpModelSelection(handle.provider, handle.configOptions, model);
    if (
      handle.configOptions.find((option) => option.id === target.configId)?.currentValue !==
      target.value
    ) {
      await this.runtimeManager.setSessionModel(sessionId, target.value);
    }
    assertCurrent();
    if (
      !confirmsAcpModelSelection(
        handle.provider,
        model,
        target.value,
        handle.configOptions.find((option) => option.id === target.configId)?.currentValue
      )
    ) {
      throw new SessionStartupTargetError(new Error('Requested startup model was not applied'));
    }
    this.writer.accept(sessionId, handle);
  }

  async applyStartupLaunchPlan(
    sessionId: string,
    session: AgentSessionRecord,
    handle: AcpProcessHandle,
    preset: SessionPermissionPreset | undefined,
    override?: boolean
  ): Promise<void> {
    const assertCurrent = this.writer.acceptRuntime(sessionId, handle);
    try {
      await this.applyLaunchPlan(sessionId, session, handle, preset, override, assertCurrent);
    } catch (error) {
      assertCurrent();
      throw new SessionStartupTargetError(error);
    }
  }

  private async applyLaunchPlan(
    sessionId: string,
    session: AgentSessionRecord,
    handle: AcpProcessHandle,
    preset: SessionPermissionPreset | undefined,
    override: boolean | undefined,
    assertCurrent: () => void
  ): Promise<void> {
    const confirmation = {
      assertCurrent,
      confirmTarget: (id: string, value: string) => {
        this.startupPermissions.expectLaunchTarget(handle, id, value);
        this.writer.accept(sessionId, handle);
      },
    };
    const launch = readSessionLaunchSettings(session.providerMetadata);
    const enabled = override ?? (launch && !launch.applied ? launch.planModeEnabled : undefined);
    await applyStartupLaunchAccess(
      sessionId,
      session,
      handle,
      this.runtimeManager,
      enabled,
      confirmation
    );
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
    const target = await requestedPlanMode(handle.provider, enabled, option, preset, () =>
      resolvePermissionPresetFromSettings(sessionId, session.workflow, session.provider)
    );
    if (!getConfigOptionValues(option).includes(target)) {
      throw new Error('Requested Plan mode is unavailable for the selected provider/model');
    }
    assertCurrent();
    if (handle.configOptions.find((entry) => entry.id === option.id)?.currentValue !== target) {
      await (handle.provider === 'CLAUDE'
        ? this.runtimeManager.setSessionMode(sessionId, target)
        : this.runtimeManager.setConfigOption(sessionId, option.id, target));
    }
    assertCurrent();
    const applied = handle.configOptions.find((entry) => entry.id === option.id)?.currentValue;
    if (!isAppliedAccessMode(handle.provider, target, applied)) {
      throw new Error('Requested Plan mode was not applied');
    }
    confirmation.confirmTarget(option.id, String(applied));
  }

  async applyStartupModePreset(
    sessionId: string,
    handle: AcpProcessHandle,
    startupModePreset: SessionStartupModePreset | undefined,
    workflow: string,
    options?: {
      persistSnapshot?: (
        sessionId: string,
        params: PersistAcpConfigSnapshotParams
      ) => Promise<void>;
    }
  ): Promise<void> {
    if (!startupModePreset) {
      return;
    }

    const didUpdate = await applyStartupCollaborationModePreset(
      this.runtimeManager,
      {
        sessionId,
        handle,
        startupModePreset,
        workflow,
        assertCurrent: this.writer.acceptRuntime(sessionId, handle),
      },
      (id, value) => this.startupPermissions.authorizeRequestedTarget(handle, id, value)
    );

    if (!didUpdate) {
      return;
    }

    const persistSnapshot =
      options?.persistSnapshot ?? this.writer.snapshots.persist.bind(this.writer.snapshots);
    const configOptions = structuredClone(handle.configOptions);
    const accepted = this.writer.accept(sessionId, handle);
    try {
      if (
        !(await accepted.persist((assertCurrent) =>
          persistSnapshot(sessionId, {
            provider: handle.provider as SessionProvider,
            providerSessionId: handle.providerSessionId,
            configOptions,
            assertCurrent,
          })
        ))
      ) {
        return;
      }
      if (!accepted.isCurrent()) {
        return;
      }

      this.writer.emitConfigOptions(sessionId, configOptions);
      this.writer.emitCapabilities(
        sessionId,
        handle.provider as SessionProvider,
        handle.configOptions
      );
    } catch (error) {
      logger.warn('Failed persisting startup mode preset configuration snapshot', {
        sessionId,
        provider: handle.provider,
        workflow,
        startupModePreset,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async applyConfiguredPermissionPreset(
    sessionId: string,
    session: AgentSessionRecord,
    handle: AcpProcessHandle,
    preResolvedPreset?: SessionPermissionPreset
  ): Promise<void> {
    if (session.workflow === ADVERSARIAL_REVIEW_WORKFLOW) {
      this.startupPermissions.captureReview(handle);
      const changed = await applyReadOnlyReviewPermissions(sessionId, handle, this.runtimeManager);
      this.startupPermissions.assertCurrent(handle);
      if (changed) {
        await this.writer.persistAndEmit(sessionId, handle);
      }
      this.startupPermissions.assertCurrent(handle);
      return;
    }

    if (await this.restoreNativeModes(sessionId, session, handle)) {
      return;
    }

    const accessModeOption = handle.configOptions.find(
      (option) => option.id === 'mode' || option.category === 'mode'
    );
    if (!accessModeOption) {
      return;
    }

    const permissionPreset =
      preResolvedPreset ??
      (await resolvePermissionPresetFromSettings(sessionId, session.workflow, session.provider));

    // Claude plan mode is also its read-only access mode. Preserve planning.
    if (handle.provider === 'CLAUDE' && accessModeOption.currentValue === 'plan') {
      this.startupPermissions.expectAccess(handle, accessModeOption.id, 'plan');
      return;
    }
    const targetAccessMode = resolveConfiguredAccessModeTarget(
      handle.provider,
      accessModeOption,
      permissionPreset
    );
    if (!targetAccessMode) {
      throw new Error(
        `Configured ${permissionPreset} access mode is unavailable for ${handle.provider}`
      );
    }

    if (
      handle.configOptions.find((option) => option.id === accessModeOption.id)?.currentValue ===
      targetAccessMode
    ) {
      this.startupPermissions.capture(handle);
      return;
    }

    try {
      await this.runtimeManager.setConfigOption(sessionId, accessModeOption.id, targetAccessMode);
      this.startupPermissions.expectAccess(handle, accessModeOption.id, targetAccessMode);
      await this.writer.persistAndEmit(sessionId, handle);
      this.startupPermissions.assertCurrent(handle);
    } catch (error) {
      logger.warn('Failed applying configured session permission preset', {
        sessionId,
        workflow: session.workflow,
        permissionPreset,
        targetAccessMode,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async restoreNativeModes(
    sessionId: string,
    session: AgentSessionRecord,
    handle: AcpProcessHandle
  ): Promise<boolean> {
    const snapshot = parseAcpConfigSnapshot(session.providerMetadata);
    if (snapshot) {
      this.startupPermissions.capture(
        handle,
        snapshot.configOptions,
        readSessionLaunchSettings(session.providerMetadata)?.planModeEnabled !== undefined
      );
    }
    const restored = await restoreSavedNativeModes(sessionId, session, handle, this.runtimeManager);
    if (restored === undefined) {
      return false;
    }
    this.startupPermissions.assertCurrent(handle);
    if (restored) {
      await this.writer.persistAndEmit(sessionId, handle);
    }
    this.startupPermissions.assertCurrent(handle);
    return true;
  }

  async applyConfiguredReasoningEffort(
    sessionId: string,
    handle: AcpProcessHandle,
    options?: {
      persistSnapshot?: boolean;
      emitUpdates?: boolean;
      session?: AgentSessionRecord;
      reasoningEffort?: string | null;
    }
  ): Promise<void> {
    const assertCurrent = this.writer.acceptRuntime(sessionId, handle);
    try {
      const target = await startupReasoningTarget(
        sessionId,
        handle,
        options?.session,
        options?.reasoningEffort
      );
      const targetReasoningEffort = target.value;
      if (!targetReasoningEffort) {
        return;
      }

      await this.writer.applyReasoningEffortTarget({
        sessionId,
        handle,
        targetReasoningEffort,
        source: 'settings',
        strict: target.strict,
        normalizeUnsupported: target.normalizeUnsupported,
        assertCurrent,
        ...(target.strict && !target.normalizeUnsupported
          ? {
              confirmTarget: (id: string, value: string) =>
                this.startupPermissions.expectLaunchTarget(handle, id, value),
            }
          : {}),
        persistSnapshot: options?.persistSnapshot,
        emitUpdates: options?.emitUpdates,
      });
    } catch (error) {
      assertCurrent();
      throw new SessionStartupTargetError(error);
    }
  }

  completeStartupConfiguration(
    sessionId: string,
    params: CompleteStartupConfigurationParams
  ): Promise<void> {
    return this.finalizer.complete(sessionId, params);
  }
}

async function requestedPlanMode(
  provider: string,
  enabled: boolean,
  option: SessionConfigOption,
  preset: SessionPermissionPreset | undefined,
  resolvePreset: () => Promise<SessionPermissionPreset>
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
  const effectivePreset = preset ?? (await resolvePreset());
  const target = effectivePreset
    ? resolveConfiguredAccessModeTarget(provider, option, effectivePreset)
    : undefined;
  if (!target) {
    throw new Error('Configured access mode is unavailable for Plan off');
  }
  return target;
}
