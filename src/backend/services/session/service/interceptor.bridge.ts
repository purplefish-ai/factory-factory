import type {
  AgentContentItem,
  AgentMessage,
  ChatMessage,
  HistoryMessage,
} from '@/shared/acp-protocol';
import { acpRuntimeManager } from './acp';
import { sessionService } from './lifecycle/session-services';
import { sessionDomainService } from './session-domain.service';

/**
 * Session capabilities exposed to backend interceptors.
 * Keeps interceptors decoupled from session lifecycle internals.
 */
export interface SessionInterceptorBridge {
  getSessionConversationHistory(sessionId: string, workingDir: string): HistoryMessage[];
  isSessionRunning(sessionId: string): boolean;
  sendSessionMessage(sessionId: string, message: string): Promise<void>;
}

function extractMessageText(message: AgentMessage): string {
  const content = message.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((item): item is Extract<AgentContentItem, { type: 'text' }> => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
    .trim();
}

function mapTranscriptEntryToHistory(entry: ChatMessage): HistoryMessage[] {
  if (entry.source === 'user') {
    return entry.text
      ? [
          {
            type: 'user',
            content: entry.text,
            timestamp: entry.timestamp,
          },
        ]
      : [];
  }

  const message = entry.message;
  if (!message || (message.type !== 'assistant' && message.type !== 'user')) {
    return [];
  }

  const content = extractMessageText(message);
  if (!content) {
    return [];
  }

  return [
    {
      type: message.type,
      content,
      timestamp: entry.timestamp,
    },
  ];
}

export const sessionInterceptorBridge: SessionInterceptorBridge = {
  getSessionConversationHistory: (sessionId, _workingDir) =>
    sessionDomainService.getTranscriptSnapshot(sessionId).flatMap(mapTranscriptEntryToHistory),
  isSessionRunning: (sessionId) => acpRuntimeManager.isSessionRunning(sessionId),
  sendSessionMessage: (sessionId, message) => sessionService.sendSessionMessage(sessionId, message),
};
