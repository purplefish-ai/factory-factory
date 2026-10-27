import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import type { AcpRuntimeManager } from '@/backend/services/session/service/acp';
import { withConfiguredAcpHandle } from '@/backend/services/session/service/acp/acp-configured-handle';

/** Native RPC, durable state, and configuration publication share one per-session transaction. */
export class SessionConfigMutationQueue {
  private readonly updates = new Map<string, Promise<void>>();

  constructor(
    private readonly runtime: Pick<AcpRuntimeManager, 'getClient' | 'isStopInProgress'>,
    private readonly publishCorrection: (sessionId: string, options: SessionConfigOption[]) => void
  ) {}

  async run(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const handle = this.runtime.getClient(sessionId);
    const prior = this.updates.get(sessionId) ?? Promise.resolve();
    const update = prior
      .catch(() => undefined)
      .then(async () => {
        if (handle && this.runtime.getClient(sessionId) !== handle) {
          throw new Error('Session runtime changed before configuration update');
        }
        try {
          if (handle) {
            await withConfiguredAcpHandle(this.runtime, sessionId, handle, operation);
          } else {
            await operation();
          }
        } catch (error) {
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
    this.updates.set(sessionId, update);
    try {
      await update;
    } finally {
      if (this.updates.get(sessionId) === update) {
        this.updates.delete(sessionId);
      }
    }
  }
}
