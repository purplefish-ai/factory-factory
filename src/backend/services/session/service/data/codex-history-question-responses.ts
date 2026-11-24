import { z } from 'zod';
import type { HistoryMessage } from '@/shared/acp-protocol';
import { buildQuestionToolDetails } from '@/shared/acp-protocol/protocol/question-response';
import { hasSecretQuestion } from '@/shared/acp-protocol/question-input';

const asyncQuestionInput = z.object({
  questions: z.array(z.object({ title: z.string().trim().min(1) })).min(1),
});
const acknowledgment = z.strictObject({ accepted: z.literal(true) });

type ToolCall = Extract<HistoryMessage, { type: 'tool_use' }>;
type PendingQuestion = {
  index: number;
  toolUseId: string;
  call: ToolCall;
  titles: string[];
};

function isAcknowledgment(content: unknown): boolean {
  if (typeof content !== 'string') {
    return false;
  }
  try {
    const body: unknown = JSON.parse(content);
    return acknowledgment.safeParse(body).success;
  } catch {
    return false;
  }
}

function readQuestion(message: HistoryMessage, index: number): PendingQuestion | undefined {
  if (
    message.type !== 'tool_use' ||
    message.toolName !== 'request_user_input_async' ||
    !message.toolId
  ) {
    return undefined;
  }
  const input = asyncQuestionInput.safeParse(message.toolInput).data;
  return input
    ? {
        index,
        toolUseId: message.toolId,
        call: message,
        titles: input.questions.map(({ title }) => title),
      }
    : undefined;
}

function acknowledgedQuestion(
  pending: PendingQuestion,
  content: HistoryMessage['content']
): HistoryMessage {
  const input = pending.call.toolInput ?? {};
  const details = hasSecretQuestion(input)
    ? undefined
    : buildQuestionToolDetails('request_user_input_async', input, content);
  return {
    type: 'question_response',
    content: pending.call.content,
    timestamp: pending.call.timestamp,
    questionResponse: {
      toolUseId: pending.toolUseId,
      status: 'unavailable',
      questions: pending.titles.map((question) => ({ question, answers: [] })),
    },
    ...(details ? { questionToolDetails: details } : {}),
  };
}

/** Older async questions saved the accepted request, without the user's eventual answer. */
export function createCodexQuestionHistoryAppender(history: HistoryMessage[]) {
  const questions = new Map<string, PendingQuestion>();
  return (message: HistoryMessage): void => {
    const question = readQuestion(message, history.length);
    if (question) {
      if (!questions.has(question.toolUseId)) {
        questions.set(question.toolUseId, question);
        history.push(message);
      }
      return;
    }

    const pending =
      message.type === 'tool_result' && message.toolId ? questions.get(message.toolId) : undefined;
    if (pending && isAcknowledgment(message.content)) {
      history[pending.index] = acknowledgedQuestion(pending, message.content);
      return;
    }
    history.push(message);
  };
}
