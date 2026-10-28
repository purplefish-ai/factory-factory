import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import type { AcpProcessHandle } from '@/backend/services/session/service/acp';
import type {
  AcceptedConfigCommit,
  SessionConfigCommitAuthority,
} from './session-config-commit-authority';
import type { SessionProvider } from './session-config-option-helpers';
import type { SessionConfigSnapshotPersistence } from './session-config-snapshot-persistence';
import type { SessionStartupPermissions } from './session-permission-policy';
import {
  matchesSessionStartupIntent,
  SessionStartupIntentChangedError,
  type SessionStartupIntent,
} from './session-startup-intent';
import type { SessionRepository } from './session.repository';

export class SessionStartupPersistenceError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
  }
}

export type CompleteStartupConfigurationParams = {
  handle: AcpProcessHandle;
  existingMetadata?: unknown;
  assertCurrent: () => void;
  beforeComplete: () => Promise<void>;
  complete: () => void;
  prepare?: () => Promise<SessionStartupIntent>;
  intent?: SessionStartupIntent;
};

/** Config owns the final durable authority and synchronous permission/readiness handoff. */
export class SessionStartupConfigurationFinalizer {
  private readonly captures = new WeakMap<
    AcpProcessHandle,
    {
      options: SessionConfigOption[];
      accepted: AcceptedConfigCommit;
    }
  >();

  constructor(
    private readonly snapshots: SessionConfigSnapshotPersistence,
    private readonly authority: SessionConfigCommitAuthority,
    private readonly permissions: SessionStartupPermissions,
    private readonly repository: Pick<SessionRepository, 'getSessionById'>
  ) {}

  async complete(sessionId: string, params: CompleteStartupConfigurationParams): Promise<void> {
    let intent = params.intent ?? (await params.prepare?.());
    for (;;) {
      const before = await this.refreshIntent(sessionId, intent, params);
      intent = before.intent;
      if (before.changed) {
        continue;
      }
      const { options, accepted } = this.capture(sessionId, params);
      const model = options.find((option) => option.category === 'model')?.currentValue;
      if (intent && typeof model === 'string') {
        intent = { ...intent, confirmedModel: model };
      }
      const result = await this.persistCurrent(sessionId, params, options, accepted, intent);
      if (result === 'intent_changed') {
        intent = await this.prepareAgain(params);
        continue;
      }
      if (result === 'superseded') {
        continue;
      }
      await params.beforeComplete();
      const after = await this.refreshIntent(sessionId, intent, params);
      intent = after.intent;
      if (after.changed) {
        continue;
      }
      params.assertCurrent();
      if (!accepted.isCurrent()) {
        continue;
      }
      this.permissions.assertCurrent(params.handle, params.existingMetadata);
      // No yield between current authority/required targets and actual readiness.
      params.complete();
      return;
    }
  }

  private async refreshIntent(
    sessionId: string,
    intent: SessionStartupIntent | undefined,
    params: CompleteStartupConfigurationParams
  ) {
    params.assertCurrent();
    this.permissions.assertCurrent(params.handle, params.existingMetadata);
    if (!intent) {
      return { intent, changed: false };
    }
    const current = await this.repository.getSessionById(sessionId);
    params.assertCurrent();
    this.permissions.assertCurrent(params.handle, params.existingMetadata);
    if (current && matchesSessionStartupIntent(current, intent)) {
      return { intent, changed: false };
    }
    return { intent: await this.prepareAgain(params), changed: true };
  }

  private prepareAgain(params: CompleteStartupConfigurationParams): Promise<SessionStartupIntent> {
    if (!params.prepare) {
      throw new SessionStartupIntentChangedError();
    }
    return params.prepare();
  }

  private async persistCurrent(
    sessionId: string,
    params: CompleteStartupConfigurationParams,
    options: SessionConfigOption[],
    accepted: AcceptedConfigCommit,
    intent: SessionStartupIntent | undefined
  ): Promise<'persisted' | 'superseded' | 'intent_changed'> {
    try {
      const persisted = await accepted.persist(async (assertCurrent) => {
        try {
          await this.snapshots.persist(sessionId, {
            provider: params.handle.provider as SessionProvider,
            providerSessionId: params.handle.providerSessionId,
            configOptions: options,
            requirePersistence: true,
            existingMetadata: params.existingMetadata,
            assertCurrent,
            startupIntent: intent,
          });
        } catch (error) {
          // Supersession/stop/replacement keep their original control-flow owner.
          assertCurrent();
          if (error instanceof SessionStartupIntentChangedError) {
            throw error;
          }
          throw new SessionStartupPersistenceError(error);
        }
      });
      return persisted ? 'persisted' : 'superseded';
    } catch (error) {
      if (error instanceof SessionStartupIntentChangedError) {
        return 'intent_changed';
      }
      throw error;
    }
  }

  private capture(sessionId: string, params: CompleteStartupConfigurationParams) {
    const options = params.handle.configOptions;
    const current = this.captures.get(params.handle);
    if (current?.options === options && current.accepted.isCurrent()) {
      return current;
    }
    const capture = { options, accepted: this.authority.accept(sessionId, params.assertCurrent) };
    this.captures.set(params.handle, capture);
    return capture;
  }
}
