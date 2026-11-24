import { createLogger } from '@/backend/services/logger.service';
import { sessionQuestionResponseAccessor } from '@/backend/services/session/resources/session-question-response.accessor';
import type { SessionDomainService } from '@/backend/services/session/service/store/session-domain.service';
import { mergeQuestionResponseHistory } from '@/backend/services/session/service/store/session-question-transcript';
import type { ChatMessage } from '@/shared/acp-protocol';
import { QuestionResponseSchema } from '@/shared/acp-protocol/protocol/question-response';

const logger = createLogger('session-question-response-history');

export function persistQuestionResponse(
  sessionId: string,
  providerSessionId: string,
  row: ChatMessage
): Promise<void> {
  const message = row.message;
  if (message?.type !== 'question_response') {
    return Promise.resolve();
  }
  return sessionQuestionResponseAccessor
    .upsert(sessionId, providerSessionId, new Date(row.timestamp), message.questionResponse)
    .catch(() => {
      logger.warn('Unable to persist question response', { sessionId });
    });
}

export async function hydrateQuestionResponseHistory(
  domain: Pick<SessionDomainService, 'getTranscriptSnapshot' | 'replaceTranscript'>,
  sessionId: string,
  providerSessionId: string,
  isCurrent = () => true
): Promise<void> {
  try {
    const rows = await sessionQuestionResponseAccessor.findBySessionId(
      sessionId,
      providerSessionId
    );
    if (!isCurrent()) {
      return;
    }
    const restored = rows.flatMap(({ toolUseId, summary, timestamp }) => {
      const parsed = QuestionResponseSchema.safeParse(summary);
      return parsed.success && parsed.data.toolUseId === toolUseId
        ? [{ summary: parsed.data, timestamp: timestamp.toISOString() }]
        : [];
    });
    if (restored.length > 0) {
      const transcript = domain.getTranscriptSnapshot(sessionId);
      domain.replaceTranscript(sessionId, mergeQuestionResponseHistory(transcript, restored));
    }
  } catch {
    logger.warn('Unable to hydrate question responses', { sessionId });
  }
}
