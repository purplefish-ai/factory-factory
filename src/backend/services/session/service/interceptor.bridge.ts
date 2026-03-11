import type { HistoryMessage } from '@/shared/acp-protocol';
import { sessionService } from './lifecycle/session.service';

/**
 * Session capabilities exposed to backend interceptors.
 * Keeps interceptors decoupled from session lifecycle internals.
 */
export interface SessionInterceptorBridge {
  getSessionConversationHistory(sessionId: string, workingDir: string): HistoryMessage[];
  isSessionRunning(sessionId: string): boolean;
  sendSessionMessage(sessionId: string, message: string): Promise<void>;
}

export const sessionInterceptorBridge: SessionInterceptorBridge = {
  getSessionConversationHistory: (sessionId, workingDir) =>
    sessionService.getSessionConversationHistory(sessionId, workingDir),
  isSessionRunning: (sessionId) => sessionService.isSessionRunning(sessionId),
  sendSessionMessage: (sessionId, message) => sessionService.sendSessionMessage(sessionId, message),
};
