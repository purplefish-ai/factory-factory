import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import type { AcpRuntimeManager } from '@/backend/services/session/service/acp';
import { withConfiguredAcpHandle } from '@/backend/services/session/service/acp/acp-configured-handle';
import type { SessionCallerGuard } from '@/backend/services/session/service/bridges';
import type { AcpProcessHandle } from '../acp/acp-process-handle';
import type { PromptConfigurationPermit } from '../acp/acp-prompt-configuration';

/** Native RPC, durable state, and configuration publication share one per-session transaction. */
export class SessionConfigMutationQueue {
  private readonly updates = new Map<
    string,
    { handle: AcpProcessHandle | undefined; update: Promise<unknown> }
  >();

  constructor(
    private readonly runtime: Pick<AcpRuntimeManager, 'getClient' | 'isStopInProgress'>,
    private readonly publishCorrection: (sessionId: string, options: SessionConfigOption[]) => void,
    private readonly assertAllowed?: (sessionId: string) => Promise<void>
  ) {}

  run<T>(sessionId: string, operation: () => Promise<T>, guard?: SessionCallerGuard): Promise<T> {
    return this.enqueue(sessionId, operation, guard, true);
  }

  runPrompt<T>(
    sessionId: string,
    operation: (permit: PromptConfigurationPermit) => Promise<T>,
    guard?: SessionCallerGuard
  ): Promise<T> {
    const handle = this.runtime.getClient(sessionId);
    if (!handle) {
      return Promise.reject(new Error('Prompt configuration runtime is unavailable'));
    }
    const admission = handle.beginPromptAdmission();
    let active = true;
    return this.enqueue(
      sessionId,
      async () => {
        const providerSessionId = handle.acpSessionId;
        const permit: PromptConfigurationPermit = {
          provider: handle.provider,
          providerSessionId: handle.providerSessionId,
          configOptions: () => structuredClone(handle.configOptions),
          assertCurrent: () => {
            if (
              !active ||
              handle.acpSessionId !== providerSessionId ||
              this.runtime.getClient(sessionId) !== handle ||
              this.runtime.isStopInProgress(sessionId)
            ) {
              throw new Error('Prompt configuration boundary is no longer current');
            }
          },
        };
        try {
          permit.assertCurrent();
          return await operation(permit);
        } finally {
          active = false;
        }
      },
      guard,
      false
    ).finally(() => {
      admission.complete();
      active = false;
    });
  }

  private async enqueue<T>(
    sessionId: string,
    operation: () => Promise<T>,
    guard: SessionCallerGuard | undefined,
    trackPending: boolean
  ): Promise<T> {
    const handle = this.runtime.getClient(sessionId);
    if (guard && !handle) {
      throw new Error('Retry runtime is unavailable');
    }
    const previous = this.updates.get(sessionId);
    const prior =
      previous && (!previous.handle || previous.handle === handle)
        ? previous.update
        : Promise.resolve();
    const work = prior
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.assertAllowed?.(sessionId);
          if (handle && this.runtime.getClient(sessionId) !== handle) {
            throw new Error('Session runtime changed before configuration update');
          }
          if (handle) {
            await handle.promptComplete;
            await this.assertAllowed?.(sessionId);
            return await withConfiguredAcpHandle(this.runtime, sessionId, handle, operation, guard);
          } else {
            if (guard) {
              await guard.check();
            }
            guard?.assertCurrent?.();
            return await operation();
          }
        } catch (error) {
          guard?.assertCurrent?.();
          const current = this.runtime.getClient(sessionId);
          if (
            current &&
            (!handle || current === handle) &&
            current.configurationReady === undefined &&
            !this.runtime.isStopInProgress(sessionId) &&
            current.configOptions.length > 0
          ) {
            this.publishCorrection(sessionId, current.configOptions);
          }
          throw error;
        }
      });
    const retired = handle?.configurationFailure;
    const update = retired === undefined ? work : Promise.race([work, retired]);
    this.updates.set(sessionId, { handle, update });
    // Register synchronously so even a direct prompt cannot overtake this edit.
    if (trackPending) {
      handle?.trackPendingConfigUpdate(update);
    }
    try {
      return await update;
    } finally {
      if (this.updates.get(sessionId)?.update === update) {
        this.updates.delete(sessionId);
      }
    }
  }
}
