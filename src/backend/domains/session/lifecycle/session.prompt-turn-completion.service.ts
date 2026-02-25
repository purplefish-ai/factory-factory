import { createLogger } from '@/backend/services/logger.service';

const logger = createLogger('session');

type PromptTurnCompleteHandler = (sessionId: string) => Promise<void> | void;

export class SessionPromptTurnCompletionService {
  private promptTurnCompleteHandler: PromptTurnCompleteHandler | null = null;
  private readonly promptTurnCompleteTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  setHandler(handler: PromptTurnCompleteHandler | null): void {
    this.promptTurnCompleteHandler = handler;
    if (!handler) {
      this.clearAll();
    }
  }

  schedule(sessionId: string): void {
    if (!this.promptTurnCompleteHandler) {
      return;
    }

    this.clearSession(sessionId);
    const timeout = setTimeout(() => {
      this.promptTurnCompleteTimeouts.delete(sessionId);
      void this.notify(sessionId);
    }, 0);
    this.promptTurnCompleteTimeouts.set(sessionId, timeout);
  }

  clearSession(sessionId: string): void {
    const timeout = this.promptTurnCompleteTimeouts.get(sessionId);
    if (!timeout) {
      return;
    }

    clearTimeout(timeout);
    this.promptTurnCompleteTimeouts.delete(sessionId);
  }

  clearAll(): void {
    for (const timeout of this.promptTurnCompleteTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.promptTurnCompleteTimeouts.clear();
  }

  private async notify(sessionId: string): Promise<void> {
    if (!this.promptTurnCompleteHandler) {
      return;
    }

    try {
      await this.promptTurnCompleteHandler(sessionId);
    } catch (error) {
      logger.warn('Prompt turn completion handler failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
