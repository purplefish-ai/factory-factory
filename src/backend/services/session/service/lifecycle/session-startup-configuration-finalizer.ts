import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import type { AcpProcessHandle } from '@/backend/services/session/service/acp';
import type {
  AcceptedConfigCommit,
  SessionConfigCommitAuthority,
} from './session-config-commit-authority';
import type { SessionProvider } from './session-config-option-helpers';
import type { SessionConfigSnapshotPersistence } from './session-config-snapshot-persistence';
import type { SessionStartupPermissions } from './session-permission-policy';

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
    private readonly permissions: SessionStartupPermissions
  ) {}

  async complete(sessionId: string, params: CompleteStartupConfigurationParams): Promise<void> {
    for (;;) {
      params.assertCurrent();
      this.permissions.assertCurrent(params.handle, params.existingMetadata);
      const { options, accepted } = this.capture(sessionId, params);
      const persisted = await accepted.persist(async (assertCurrent) => {
        try {
          await this.snapshots.persist(sessionId, {
            provider: params.handle.provider as SessionProvider,
            providerSessionId: params.handle.providerSessionId,
            configOptions: options,
            existingMetadata: params.existingMetadata,
            assertCurrent,
          });
        } catch (error) {
          // Supersession, stop and replacement retain their original control-flow owner.
          assertCurrent();
          throw new SessionStartupPersistenceError(error);
        }
      });
      if (!persisted) {
        continue;
      }
      // Request-only cancellation must not become a terminal storage failure.
      await params.beforeComplete();
      params.assertCurrent();
      if (!accepted.isCurrent()) {
        continue;
      }
      this.permissions.assertCurrent(params.handle, params.existingMetadata);
      // Do not yield between current authority/access validation and actual readiness.
      params.complete();
      return;
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
