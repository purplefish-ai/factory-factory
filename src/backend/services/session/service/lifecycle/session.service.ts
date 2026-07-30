import type { ContentBlock } from '@agentclientprotocol/sdk';
import pLimit, { type LimitFunction } from 'p-limit';
import { createLogger } from '@/backend/services/logger.service';
import type { AcpRuntimeManager } from '@/backend/services/session/service/acp';
import type { SessionLifecycleWorkspaceBridge } from '@/backend/services/session/service/bridges';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { AgentContentItem } from '@/shared/acp-protocol';
import type { SessionRuntimeState } from '@/shared/session-runtime';
import type { AcpEventProcessor } from './acp-event-processor';
import { toErrorMessage } from './session.error-message';
import type { SessionPromptTurnCompletionService } from './session.prompt-turn-completion.service';

const logger = createLogger('session');
const DEFAULT_USER_PROMPT_TIMEOUT_MS = 60 * 60 * 1000;
const TURN_ALREADY_IN_PROGRESS_REASON = 'A turn is already in progress for this session';

export type SessionServiceDependencies = {
  runtimeManager: AcpRuntimeManager;
  sessionDomainService: SessionDomainService;
  acpEventProcessor: AcpEventProcessor;
  promptTurnCompletionService: SessionPromptTurnCompletionService;
  getStopGeneration: (sessionId: string) => number;
  isStopGenerationCurrent: (sessionId: string, stopGeneration: number) => boolean;
  isSessionStopping: (sessionId: string) => boolean;
};

export class SessionService {
  private readonly runtimeManager: AcpRuntimeManager;
  private readonly sessionDomainService: SessionDomainService;
  private readonly acpEventProcessor: AcpEventProcessor;
  private readonly promptTurnCompletionService: SessionPromptTurnCompletionService;
  private readonly getStopGeneration: (sessionId: string) => number;
  private readonly isStopGenerationCurrent: (sessionId: string, stopGeneration: number) => boolean;
  private readonly isSessionStopping: (sessionId: string) => boolean;
  private readonly acpPromptLimiters = new Map<string, LimitFunction>();
  /** Cross-domain bridge for workspace activity (injected by orchestration layer) */
  private workspaceBridge: SessionLifecycleWorkspaceBridge | null = null;

  constructor(options: SessionServiceDependencies) {
    this.runtimeManager = options.runtimeManager;
    this.sessionDomainService = options.sessionDomainService;
    this.acpEventProcessor = options.acpEventProcessor;
    this.promptTurnCompletionService = options.promptTurnCompletionService;
    this.getStopGeneration = options.getStopGeneration;
    this.isStopGenerationCurrent = options.isStopGenerationCurrent;
    this.isSessionStopping = options.isSessionStopping;
  }

  /**
   * Configure the workspace activity bridge used while ACP prompts are running.
   */
  configure(bridges: { workspace: SessionLifecycleWorkspaceBridge }): void {
    this.workspaceBridge = bridges.workspace;
  }

  sendSessionMessage(sessionId: string, content: string | AgentContentItem[]): Promise<void> {
    const acpClient = this.runtimeManager.getClient(sessionId);
    if (acpClient) {
      const prompt: ContentBlock[] =
        typeof content === 'string'
          ? [{ type: 'text', text: content }]
          : this.toContentBlocks(content, acpClient.supportsImages());
      return this.sendAcpMessage(sessionId, prompt, DEFAULT_USER_PROMPT_TIMEOUT_MS)
        .then(() => undefined)
        .catch((error) => {
          const errorMessage = toErrorMessage(error);
          if (this.isTurnAlreadyInProgressError(error)) {
            logger.debug('ACP prompt deferred because a turn is already in progress', {
              sessionId,
              error: errorMessage,
            });
          } else {
            logger.error('ACP prompt failed', {
              sessionId,
              error: errorMessage,
            });
          }
          throw error;
        });
    }

    const error = new Error(`No ACP client found for sendSessionMessage: ${sessionId}`);
    logger.warn('No ACP client found for sendSessionMessage', { sessionId });
    return Promise.reject(error);
  }

  /**
   * Convert internal AgentContentItem[] to ACP ContentBlock[].
   */
  private toContentBlocks(content: AgentContentItem[], supportsImages: boolean): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    for (const item of content) {
      switch (item.type) {
        case 'text':
          blocks.push({ type: 'text', text: item.text });
          break;
        case 'thinking':
          blocks.push({ type: 'text', text: item.thinking });
          break;
        case 'image':
          if (supportsImages) {
            blocks.push({
              type: 'image',
              data: item.source.data,
              mimeType: item.source.media_type,
            });
          } else {
            blocks.push({ type: 'text', text: '[Image: not supported by this provider]' });
          }
          break;
        case 'tool_result':
          if (typeof item.content === 'string') {
            blocks.push({ type: 'text', text: item.content });
          } else {
            blocks.push({ type: 'text', text: JSON.stringify(item.content) });
          }
          break;
        default:
          break;
      }
    }
    return blocks;
  }

  /**
   * Send a message via ACP runtime. Returns the stop reason from the prompt response.
   * The prompt() call blocks until the turn completes; streaming events arrive
   * concurrently via the AcpClientHandler.sessionUpdate callback.
   */
  sendAcpMessage(sessionId: string, prompt: ContentBlock[], timeoutMs?: number): Promise<string> {
    return this.withSerializedAcpPrompt(sessionId, () =>
      this.executeAcpMessage(sessionId, prompt, timeoutMs)
    );
  }

  private withSerializedAcpPrompt<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const limiter = this.getAcpPromptLimiter(sessionId);
    const result = limiter(task);
    const cleanup = () => this.deleteAcpPromptLimiterIfDrained(sessionId, limiter);
    result.then(cleanup, cleanup);
    return result;
  }

  clearQueuedAcpPrompts(sessionId: string): void {
    const limiter = this.acpPromptLimiters.get(sessionId);
    if (!limiter) {
      return;
    }
    limiter.clearQueue();
    // A stop can kill the ACP process while the active prompt promise never
    // settles. Drop the limiter so a later restart is not queued behind that
    // stale in-flight turn.
    this.acpPromptLimiters.delete(sessionId);
  }

  private deleteAcpPromptLimiterIfDrained(sessionId: string, limiter: LimitFunction): void {
    if (
      this.acpPromptLimiters.get(sessionId) === limiter &&
      limiter.activeCount === 0 &&
      limiter.pendingCount === 0
    ) {
      this.acpPromptLimiters.delete(sessionId);
    }
  }

  private getAcpPromptLimiter(sessionId: string): LimitFunction {
    const existing = this.acpPromptLimiters.get(sessionId);
    if (existing) {
      return existing;
    }
    const limiter = pLimit({ concurrency: 1, rejectOnClear: true });
    this.acpPromptLimiters.set(sessionId, limiter);
    return limiter;
  }

  private async executeAcpMessage(
    sessionId: string,
    prompt: ContentBlock[],
    timeoutMs?: number
  ): Promise<string> {
    const stopGeneration = this.getStopGeneration(sessionId);
    const workspaceId = this.acpEventProcessor.getWorkspaceId(sessionId);
    let workspaceActivityGeneration: number | undefined;
    let promptCompleted = false;
    let promptError: unknown;
    let promptErrorSet = false;
    // Scope orphan detection to each prompt turn.
    this.acpEventProcessor.beginPromptTurn(sessionId);

    this.sessionDomainService.setRuntimeSnapshot(sessionId, {
      phase: 'running',
      processState: 'alive',
      activity: 'WORKING',
      updatedAt: new Date().toISOString(),
    });

    if (workspaceId && this.workspaceBridge) {
      workspaceActivityGeneration = this.workspaceBridge.markSessionRunning(workspaceId, sessionId);
    }

    try {
      const result = await this.runtimeManager.sendPrompt(sessionId, prompt, timeoutMs);
      promptCompleted = true;
      this.completePromptTurnIfCurrent(
        sessionId,
        stopGeneration,
        `stop_reason:${result.stopReason}`,
        {
          phase: 'idle',
          processState: 'alive',
          activity: 'IDLE',
          updatedAt: new Date().toISOString(),
        }
      );
      return result.stopReason;
    } catch (error) {
      promptError = error;
      promptErrorSet = true;
      this.completePromptTurnIfCurrent(sessionId, stopGeneration, 'prompt_error', {
        phase: 'error',
        processState: 'alive',
        activity: 'IDLE',
        errorMessage: toErrorMessage(error),
        updatedAt: new Date().toISOString(),
      });
      throw error;
    } finally {
      if (workspaceId && this.workspaceBridge) {
        if (workspaceActivityGeneration === undefined) {
          this.workspaceBridge.markSessionIdle(workspaceId, sessionId);
        } else {
          this.workspaceBridge.markSessionIdle(workspaceId, sessionId, workspaceActivityGeneration);
        }
      }
      if (
        (promptCompleted || (promptErrorSet && !this.isTurnAlreadyInProgressError(promptError))) &&
        !this.isSessionStopping(sessionId) &&
        this.isStopGenerationCurrent(sessionId, stopGeneration)
      ) {
        this.promptTurnCompletionService.schedule(sessionId);
      }
    }
  }

  private completePromptTurnIfCurrent(
    sessionId: string,
    stopGeneration: number,
    orphanedToolCallReason: string,
    runtime: SessionRuntimeState
  ): void {
    if (!this.isStopGenerationCurrent(sessionId, stopGeneration)) {
      return;
    }
    this.acpEventProcessor.finishPromptTurn(sessionId);
    this.acpEventProcessor.finalizeOrphanedToolCalls(sessionId, orphanedToolCallReason);
    this.sessionDomainService.setRuntimeSnapshot(sessionId, runtime);
  }

  private isTurnAlreadyInProgressError(error: unknown): boolean {
    return toErrorMessage(error).includes(TURN_ALREADY_IN_PROGRESS_REASON);
  }
}
