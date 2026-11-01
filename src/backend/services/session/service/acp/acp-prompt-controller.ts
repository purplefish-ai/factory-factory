import type { ContentBlock } from '@agentclientprotocol/sdk/unstable';
import { z } from 'zod';
import { createLogger } from '@/backend/services/logger.service';
import type { AcpProcessHandle } from './acp-process-handle';
import { PromptTimeoutError } from './acp-runtime-errors';

const logger = createLogger('acp-runtime-manager');

const promptFailureSchema = z.object({
  _meta: z.object({
    jetbrains: z.object({
      air: z.object({
        sessionFailure: z.object({
          severity: z.enum(['error', 'warning']),
          title: z.string().trim().min(1),
        }),
      }),
    }),
  }),
});

export type AcpPromptRuntimePort = {
  isCurrentHandle(sessionId: string, handle: AcpProcessHandle): boolean;
  stopClient(sessionId: string): Promise<void>;
};

/** Transport-neutral durable boundary; full RPC completion is terminal, never early acceptance. */
export type AcpPromptObservation = {
  assertCurrent(): void;
  beforeSend(): Promise<void>;
  outcome(result: {
    stopReason: string;
    result: 'COMPLETED' | 'FAILED' | 'CANCELLED';
  }): Promise<void>;
  ambiguous(): Promise<void>;
};

export class AcpPromptController {
  private readonly pendingObserved = new WeakMap<AcpProcessHandle, { cancelled: boolean }>();
  constructor(private readonly runtime: AcpPromptRuntimePort) {}

  async sendPrompt(
    sessionId: string,
    handle: AcpProcessHandle,
    prompt: ContentBlock[],
    timeoutMs?: number,
    observation?: AcpPromptObservation
  ): Promise<{ stopReason: string }> {
    const pending = { cancelled: false };
    if (observation) {
      this.pendingObserved.set(handle, pending);
    }
    let sendingRecorded = false;
    let terminalRecorded = false;
    try {
      if (observation) {
        observation.assertCurrent();
        await observation.beforeSend();
        sendingRecorded = true;
        observation.assertCurrent();
        if (pending.cancelled) {
          throw new Error('Prompt cancelled before send');
        }
        this.releasePending(handle, pending);
      }
      handle.isPromptInFlight = true;
      const promptPromise = handle.connection.prompt({
        sessionId: handle.acpSessionId,
        prompt,
      });

      const result = await awaitPromptResponse(promptPromise, sessionId, timeoutMs);

      // ACP v1 can resolve with end_turn even after a terminal provider error.
      // Only the negotiated failure metadata distinguishes that from success.
      const failure = promptFailureSchema.safeParse(result);
      const failed =
        failure.success && failure.data._meta.jetbrains.air.sessionFailure.severity === 'error';
      if (observation) {
        observation.assertCurrent();
        await observation.outcome({
          stopReason: result.stopReason,
          result: promptOutcome(failed, result.stopReason),
        });
        terminalRecorded = true;
      }
      if (failed) {
        throw new Error(failure.data._meta.jetbrains.air.sessionFailure.title);
      }
      handle.isPromptInFlight = false;
      return { stopReason: result.stopReason };
    } catch (error) {
      if (observation && sendingRecorded && !terminalRecorded) {
        // Failed evidence writes must not release the initial-delivery fence.
        await observation.ambiguous().catch(() => {
          logger.warn('Initial delivery ambiguity persistence failed', { sessionId });
        });
      }
      if (error instanceof PromptTimeoutError && !observation) {
        await this.escalatePromptTimeout(sessionId, handle, timeoutMs);
      }
      handle.isPromptInFlight = false;
      throw error;
    } finally {
      this.releasePending(handle, pending);
    }
  }

  private releasePending(handle: AcpProcessHandle, pending: { cancelled: boolean }): void {
    if (this.pendingObserved.get(handle) === pending) {
      this.pendingObserved.delete(handle);
    }
  }

  /** Returns true when a prompt was actually in flight and got cancelled. */
  async cancelPrompt(sessionId: string, handle: AcpProcessHandle | undefined): Promise<boolean> {
    if (!(handle && this.runtime.isCurrentHandle(sessionId, handle))) {
      return false;
    }

    const pending = this.pendingObserved.get(handle);
    if (pending) {
      pending.cancelled = true;
      handle.permissionBridge?.cancelAll();
      return true;
    }
    if (!handle.isPromptInFlight) {
      return false;
    }

    handle.permissionBridge?.cancelAll();
    await handle.connection.cancel({
      sessionId: handle.acpSessionId,
    });
    return true;
  }

  /** Attempt graceful cancel after a prompt timeout, then escalate to kill. */
  private async escalatePromptTimeout(
    sessionId: string,
    timedOutHandle: AcpProcessHandle,
    timeoutMs: number | undefined
  ): Promise<void> {
    if (!this.isCurrentPromptTimeoutHandle(sessionId, timedOutHandle, timeoutMs)) {
      return;
    }

    logger.warn('Prompt timed out, attempting cancel', { sessionId, timeoutMs });
    try {
      const cancelled = await Promise.race([
        this.cancelPrompt(sessionId, timedOutHandle).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
      ]);
      if (!this.isCurrentPromptTimeoutHandle(sessionId, timedOutHandle, timeoutMs)) {
        return;
      }
      if (!cancelled) {
        logger.warn('Cancel timed out after prompt timeout, stopping client', { sessionId });
        timedOutHandle.isPromptInFlight = false;
        await this.runtime.stopClient(sessionId).catch(() => {
          // Best-effort cleanup
        });
      }
    } catch {
      if (!this.isCurrentPromptTimeoutHandle(sessionId, timedOutHandle, timeoutMs)) {
        return;
      }
      // Cancel failed — stop the client forcibly
      logger.warn('Cancel failed after timeout, stopping client', { sessionId });
      timedOutHandle.isPromptInFlight = false;
      await this.runtime.stopClient(sessionId).catch(() => {
        // Best-effort cleanup
      });
    }
  }

  private isCurrentPromptTimeoutHandle(
    sessionId: string,
    timedOutHandle: AcpProcessHandle,
    timeoutMs: number | undefined
  ): boolean {
    if (this.runtime.isCurrentHandle(sessionId, timedOutHandle)) {
      return true;
    }

    logger.info('Ignoring stale prompt timeout for replaced ACP session', {
      sessionId,
      timeoutMs,
    });
    return false;
  }
}

async function awaitPromptResponse(
  prompt: Promise<{ stopReason: string }>,
  sessionId: string,
  timeoutMs?: number
): Promise<{ stopReason: string }> {
  if (timeoutMs == null || timeoutMs <= 0) {
    return await prompt;
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new PromptTimeoutError(sessionId, timeoutMs)), timeoutMs);
    prompt.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function promptOutcome(failed: boolean, reason: string): 'FAILED' | 'CANCELLED' | 'COMPLETED' {
  return failed ? 'FAILED' : reason === 'cancelled' ? 'CANCELLED' : 'COMPLETED';
}
