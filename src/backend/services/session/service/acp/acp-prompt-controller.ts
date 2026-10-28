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

export class AcpPromptController {
  constructor(private readonly runtime: AcpPromptRuntimePort) {}

  async sendPrompt(
    sessionId: string,
    handle: AcpProcessHandle,
    prompt: ContentBlock[],
    timeoutMs?: number
  ): Promise<{ stopReason: string }> {
    handle.isPromptInFlight = true;
    try {
      const promptPromise = handle.connection.prompt({
        sessionId: handle.acpSessionId,
        prompt,
      });

      let result: { stopReason: string };
      if (timeoutMs != null && timeoutMs > 0) {
        result = await new Promise<{ stopReason: string }>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new PromptTimeoutError(sessionId, timeoutMs)),
            timeoutMs
          );
          promptPromise.then(
            (response) => {
              clearTimeout(timer);
              resolve(response);
            },
            (error) => {
              clearTimeout(timer);
              reject(error);
            }
          );
        });
      } else {
        result = await promptPromise;
      }

      // ACP v1 can resolve with end_turn even after a terminal provider error.
      // Only the negotiated failure metadata distinguishes that from success.
      const failure = promptFailureSchema.safeParse(result);
      if (failure.success && failure.data._meta.jetbrains.air.sessionFailure.severity === 'error') {
        throw new Error(failure.data._meta.jetbrains.air.sessionFailure.title);
      }
      handle.isPromptInFlight = false;
      return { stopReason: result.stopReason };
    } catch (error) {
      if (error instanceof PromptTimeoutError) {
        await this.escalatePromptTimeout(sessionId, handle, timeoutMs);
      }
      handle.isPromptInFlight = false;
      throw error;
    }
  }

  /** Returns true when a prompt was actually in flight and got cancelled. */
  async cancelPrompt(sessionId: string, handle: AcpProcessHandle | undefined): Promise<boolean> {
    if (!(handle && this.runtime.isCurrentHandle(sessionId, handle))) {
      return false;
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
