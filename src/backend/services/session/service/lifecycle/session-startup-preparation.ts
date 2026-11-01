import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpProcessHandle, PermissionPreset } from '@/backend/services/session/service/acp';
import { ADVERSARIAL_REVIEW_WORKFLOW } from '@/shared/adversarial-review';
import type { EventAgentExecution } from '@/shared/event-agent-launch';
import { pinEventExecution } from './event-session-startup';
import { SessionStartupTargetError } from './session-permission-policy';
import { restorePRResumeConfig } from './session-pr-resume-config';
import { captureSessionStartupIntent } from './session-startup-intent';
import type { SessionConfigService } from './session.config.service';
import type { SessionRepository } from './session.repository';

export type SessionStartupPreparationOptions = {
  eventExecution?: EventAgentExecution;
  resumePolicy?: 'allow_fallback' | 'require_existing';
  model?: string;
  reasoningEffort?: string | null;
  planModeEnabled?: boolean;
  startupModePreset?: 'non_interactive' | 'plan';
  permissionPreset?: PermissionPreset;
};

type StartupConfig = Pick<
  SessionConfigService,
  | 'requireSavedStartupAccess'
  | 'applyStartupModel'
  | 'applyConfiguredReasoningEffort'
  | 'applyConfiguredPermissionPreset'
  | 'applyStartupModePreset'
  | 'applyStartupLaunchPlan'
  | 'persistAcpConfigSnapshot'
>;

/** Reconcile durable desired state after runtime handoff; consume none of it here. */
export async function prepareSessionStartup(
  sessionId: string,
  handle: AcpProcessHandle,
  options: SessionStartupPreparationOptions,
  deps: {
    repository: Pick<SessionRepository, 'getSessionById'>;
    config: StartupConfig;
    assertCurrent(): void;
    checkCurrent(): Promise<void>;
    isRequestFailure(error: unknown): boolean;
  }
) {
  try {
    const record = await deps.repository.getSessionById(sessionId);
    deps.assertCurrent();
    const current = requireCurrentStartupRecord(record, handle);
    const session = pinEventExecution(current, options.eventExecution);
    const desired = captureSessionStartupIntent(session);
    await deps.config.applyStartupModel(sessionId, handle, options.model ?? session.model);
    await deps.checkCurrent();
    if (options.resumePolicy === 'require_existing') {
      deps.config.requireSavedStartupAccess(handle, session.providerMetadata);
      await restorePRResumeConfig(session, handle, deps.assertCurrent);
    } else {
      await deps.config.applyConfiguredReasoningEffort(sessionId, handle, {
        persistSnapshot: false,
        emitUpdates: false,
        session,
        reasoningEffort: options.reasoningEffort,
      });
    }
    await deps.checkCurrent();
    const reviewer = session.workflow === ADVERSARIAL_REVIEW_WORKFLOW;
    if (options.resumePolicy !== 'require_existing' || reviewer) {
      await deps.config.applyConfiguredPermissionPreset(
        sessionId,
        session,
        handle,
        options.permissionPreset
      );
    }
    if (!(handle.provider === 'CLAUDE' && options.startupModePreset === 'non_interactive')) {
      await deps.config.applyStartupModePreset(
        sessionId,
        handle,
        options.startupModePreset,
        session.workflow,
        { persistSnapshot: deps.config.persistAcpConfigSnapshot.bind(deps.config) }
      );
    }
    await deps.config.applyStartupLaunchPlan(
      sessionId,
      session,
      handle,
      options.permissionPreset,
      options.planModeEnabled
    );
    if (reviewer) {
      await deps.config.applyConfiguredPermissionPreset(
        sessionId,
        session,
        handle,
        options.permissionPreset
      );
    }
    await deps.checkCurrent();
    const confirmedModel = handle.configOptions.find(
      (option) => option.category === 'model'
    )?.currentValue;
    return {
      ...desired,
      overrides: {
        reasoningEffort: options.reasoningEffort,
        planModeEnabled: options.planModeEnabled,
      },
      ...(typeof confirmedModel === 'string' ? { confirmedModel } : {}),
    };
  } catch (error) {
    try {
      deps.assertCurrent();
    } catch {
      throw error;
    }
    if (deps.isRequestFailure(error)) {
      throw error;
    }
    throw new SessionStartupTargetError(error);
  }
}

function requireCurrentStartupRecord(
  session: AgentSessionRecord | null,
  handle: AcpProcessHandle
): AgentSessionRecord {
  if (
    !session ||
    session.provider !== handle.provider ||
    (session.providerSessionId && session.providerSessionId !== handle.providerSessionId)
  ) {
    throw new Error('Session runtime changed during startup intent preparation');
  }
  return session;
}
