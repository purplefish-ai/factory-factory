import type { ChatMessage } from '@/shared/acp-protocol';
import {
  CODEX_ASYNC_QUESTION_TOOL,
  type QuestionResponse,
} from '@/shared/acp-protocol/protocol/question-response';
import { normalizeCodexAsyncQuestionResponse } from '@/shared/acp-protocol/question-response-summary';

type StoredResponse = { summary: QuestionResponse; timestamp: string };

const legacyAsyncHeader =
  'Codex keeps working while you answer. An answer sent after it finishes is not delivered.';

function answerSignature(summary: QuestionResponse): string | undefined {
  if (summary.status !== 'answered' || summary.questions.some(({ redacted }) => redacted)) {
    return undefined;
  }
  return JSON.stringify(
    summary.questions.map(({ question, answers, note }) => [
      question.trim(),
      [...answers, note ?? ''].filter((answer) => answer.trim()).join('\n\n'),
    ])
  );
}

function addUnique(index: Map<string, string | null>, signature: string, toolUseId: string): void {
  index.set(signature, index.has(signature) ? null : toolUseId);
}

function indexLegacyResponses(restored: StoredResponse[]): Map<string, string | null> {
  const local = new Map<string, string | null>();
  for (const { summary } of restored) {
    if (
      !summary.toolUseId.startsWith('elicitation:') ||
      summary.questions[0]?.header !== legacyAsyncHeader
    ) {
      continue;
    }
    const signature = answerSignature(summary);
    if (signature !== undefined) {
      addUnique(local, signature, summary.toolUseId);
    }
  }
  return local;
}

function matchDeliveredReplies(
  transcript: ChatMessage[],
  local: Map<string, string | null>
): Map<string, string> {
  if (local.size === 0) {
    return new Map();
  }

  const delivered = new Map<string, string | null>();
  for (const { message } of transcript) {
    if (
      message?.type !== 'question_response' ||
      message.questionToolDetails?.toolName !== CODEX_ASYNC_QUESTION_TOOL
    ) {
      continue;
    }
    const signature = answerSignature(message.questionResponse);
    if (signature !== undefined && local.has(signature)) {
      addUnique(delivered, signature, message.questionResponse.toolUseId);
    }
  }

  const matches = new Map<string, string>();
  for (const [signature, toolUseId] of delivered) {
    const legacyId = local.get(signature);
    if (toolUseId && legacyId) {
      matches.set(legacyId, toolUseId);
    }
  }
  return matches;
}

/** Keep a live reply until its matching delivered row is present in the rollout. */
export function retainUndeliveredCodexReplies(
  history: ChatMessage[],
  localRows: ChatMessage[]
): ChatMessage[] {
  const local = new Map<string, string | null>();
  for (const { id, message } of localRows) {
    if (
      message?.type === 'question_response' &&
      message.questionToolDetails?.toolName === CODEX_ASYNC_QUESTION_TOOL
    ) {
      const signature = answerSignature(message.questionResponse);
      if (signature !== undefined) {
        addUnique(local, signature, id);
      }
    }
  }
  const matches = matchDeliveredReplies(history, local);
  if (matches.size === 0) {
    return localRows;
  }
  const deliveredAt = new Map<string, number>();
  for (const { message, timestamp } of history) {
    if (message?.type === 'question_response') {
      deliveredAt.set(message.questionResponse.toolUseId, Date.parse(timestamp));
    }
  }
  return localRows.filter(({ id, timestamp }) => {
    const toolUseId = matches.get(id);
    const deliveredTime = toolUseId ? deliveredAt.get(toolUseId) : undefined;
    return !(deliveredTime !== undefined && deliveredTime >= Date.parse(timestamp));
  });
}

/** Older async forms had synthetic IDs. Correlate only unambiguous matches to delivered replies. */
export function reconcileLegacyCodexQuestionOverlays(
  transcript: ChatMessage[],
  restored: StoredResponse[]
): { transcript: ChatMessage[]; restored: StoredResponse[] } {
  const matches = matchDeliveredReplies(transcript, indexLegacyResponses(restored));
  if (matches.size === 0) {
    return { transcript, restored };
  }
  return {
    transcript: transcript.filter(
      ({ message }) =>
        message?.type !== 'question_response' || !matches.has(message.questionResponse.toolUseId)
    ),
    restored: restored.map((row) => {
      const toolUseId = matches.get(row.summary.toolUseId);
      return toolUseId
        ? { ...row, summary: normalizeCodexAsyncQuestionResponse({ ...row.summary, toolUseId }) }
        : row;
    }),
  };
}
