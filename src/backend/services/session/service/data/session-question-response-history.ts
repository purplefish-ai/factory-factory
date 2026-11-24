import { createLogger } from '@/backend/services/logger.service';
import { sessionQuestionResponseAccessor } from '@/backend/services/session/resources/session-question-response.accessor';
import type { SessionDomainService } from '@/backend/services/session/service/store/session-domain.service';
import { mergeQuestionResponseHistory } from '@/backend/services/session/service/store/session-question-transcript';
import type { ChatMessage } from '@/shared/acp-protocol';
import { QuestionResponseSchema } from '@/shared/acp-protocol/protocol/question-response';
import {
  createProviderHistoryHydrator,
  getProviderHistorySessionId,
  type ProviderHistoryHydrationDomain,
} from './session-provider-history-hydrator';

const logger = createLogger('session-question-response-history');

// Reloads can start on a new socket while the answer command is still settling.
const pendingWrites = new Map<string, Promise<void>>();

function historyKey(sessionId: string, providerSessionId: string): string {
  return JSON.stringify([sessionId, providerSessionId]);
}

/** Restore provider history and its local question overlays under the same identity fence. */
export function createSessionTranscriptHydrator(domain: ProviderHistoryHydrationDomain) {
  const hydrateProviderHistory = createProviderHistoryHydrator(domain);
  const hydrateTranscript: ReturnType<typeof createProviderHistoryHydrator> = async (
    sessionId,
    session,
    isCurrent
  ) => {
    const providerSessionId = getProviderHistorySessionId(session);
    if (!providerSessionId) {
      await hydrateProviderHistory(sessionId, session, isCurrent);
      return;
    }
    const providerIsCurrent = domain.createProviderHistoryFence(sessionId, providerSessionId);
    const loadIsCurrent = () => providerIsCurrent?.() === true && isCurrent?.() !== false;
    if (!loadIsCurrent()) {
      return;
    }
    await hydrateProviderHistory(sessionId, session, loadIsCurrent);
    if (loadIsCurrent()) {
      await hydrateQuestionResponseHistory(domain, sessionId, providerSessionId, loadIsCurrent);
    }
  };
  return hydrateTranscript;
}

export function persistQuestionResponse(
  sessionId: string,
  providerSessionId: string,
  row: ChatMessage
): Promise<void> {
  const message = row.message;
  if (message?.type !== 'question_response') {
    return Promise.resolve();
  }
  const key = historyKey(sessionId, providerSessionId);
  const previousWrite = pendingWrites.get(key) ?? Promise.resolve();
  const write = previousWrite
    .then(() =>
      sessionQuestionResponseAccessor.upsert(
        sessionId,
        providerSessionId,
        new Date(row.timestamp),
        message.questionResponse
      )
    )
    .catch(() => {
      logger.warn('Unable to persist question response for future history loads', {
        sessionId,
      });
    })
    .finally(() => {
      if (pendingWrites.get(key) === write) {
        pendingWrites.delete(key);
      }
    });
  pendingWrites.set(key, write);
  return write;
}

export async function hydrateQuestionResponseHistory(
  domain: Pick<SessionDomainService, 'getTranscriptSnapshot' | 'replaceTranscript'>,
  sessionId: string,
  providerSessionId: string,
  isCurrent = () => true
): Promise<void> {
  try {
    await pendingWrites.get(historyKey(sessionId, providerSessionId));
    if (!isCurrent()) {
      return;
    }
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
