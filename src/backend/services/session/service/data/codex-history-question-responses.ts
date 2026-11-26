import { z } from 'zod';
import type { HistoryMessage } from '@/shared/acp-protocol';
import {
  buildQuestionToolDetails,
  CODEX_ASYNC_QUESTION_TOOL,
} from '@/shared/acp-protocol/protocol/question-response';
import { hasSecretQuestion, isSecretQuestion } from '@/shared/acp-protocol/question-input';

const asyncQuestionInput = z.object({
  questions: z.array(z.object({ title: z.string().trim().min(1) }).passthrough()).min(1),
});
const acknowledgment = z.strictObject({ accepted: z.literal(true) });
const replyEnvelope =
  /^\s*<send_user_message_question_reply>([\s\S]*)<\/send_user_message_question_reply>\s*$/;
const replyId = z.tuple([
  z.literal(CODEX_ASYNC_QUESTION_TOOL),
  z.string().min(1),
  z.int().nonnegative(),
]);
const replyItem = z.object({
  questionItemId: z.string(),
  question: z.string().min(1),
  answer: z.string().min(1),
});
const replyBody = z.union([z.array(replyItem).min(1), replyItem]);

type ToolCall = Extract<HistoryMessage, { type: 'tool_use' }>;
type QuestionReply = Extract<HistoryMessage, { type: 'question_response' }>;
type ReplyField = QuestionReply['questionResponse']['questions'][number];
type PendingQuestion = {
  index: number;
  toolUseId: string;
  call: ToolCall;
  fields: z.infer<typeof asyncQuestionInput>['questions'];
  answers: Map<string, string>;
  acknowledgment?: string;
  delivery?: { index: number; timestamp: string };
};
type UnmatchedReply = { index: number; fields: Map<string, ReplyField> };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Codex steers async answers into the active turn as a synthetic user message.
export function parseCodexAsyncQuestionReply(message: HistoryMessage): QuestionReply[] {
  if (message.type !== 'user' || message.attachments?.length) {
    return [];
  }
  const body = replyEnvelope.exec(message.content)?.[1];
  if (!body) {
    return [];
  }
  const parsed = replyBody.safeParse(parseJson(body));
  if (!parsed.success) {
    return [];
  }

  const grouped = new Map<string, ReplyField[]>();
  for (const item of Array.isArray(parsed.data) ? parsed.data : [parsed.data]) {
    const identity = replyId.safeParse(parseJson(item.questionItemId));
    if (!identity.success) {
      return [];
    }
    const [, toolUseId, index] = identity.data;
    const fields = grouped.get(toolUseId) ?? [];
    fields.push({ id: String(index), question: item.question, answers: [item.answer] });
    grouped.set(toolUseId, fields);
  }
  return Array.from(grouped, ([toolUseId, questions]) => ({
    type: 'question_response',
    content: '',
    timestamp: message.timestamp,
    questionResponse: { toolUseId, status: 'answered', questions },
  }));
}

function readQuestion(message: HistoryMessage, index: number): PendingQuestion | undefined {
  if (
    message.type !== 'tool_use' ||
    message.toolName !== CODEX_ASYNC_QUESTION_TOOL ||
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
        fields: input.questions,
        answers: new Map(),
      }
    : undefined;
}

function projectQuestion(pending: PendingQuestion): QuestionReply {
  const input = pending.call.toolInput ?? {};
  const details = hasSecretQuestion(input)
    ? undefined
    : buildQuestionToolDetails(CODEX_ASYNC_QUESTION_TOOL, input, pending.acknowledgment);
  return {
    type: 'question_response',
    content: pending.call.content,
    timestamp: pending.delivery?.timestamp ?? pending.call.timestamp,
    questionResponse: {
      toolUseId: pending.toolUseId,
      status: pending.answers.size > 0 ? 'answered' : 'unavailable',
      questions: pending.fields.map((field, index) => {
        const answer = pending.answers.get(String(index));
        const redacted = isSecretQuestion(field);
        return {
          question: field.title,
          answers: answer !== undefined && !redacted ? [answer] : [],
          ...(redacted ? { redacted: true as const } : {}),
        };
      }),
    },
    ...(details ? { questionToolDetails: details } : {}),
  };
}

function foldAnswer(pending: PendingQuestion, fields: Iterable<ReplyField>): void {
  for (const { id, answers } of fields) {
    const answer = answers[0];
    if (
      id !== undefined &&
      Number(id) < pending.fields.length &&
      answer !== undefined &&
      !pending.answers.has(id)
    ) {
      pending.answers.set(id, answer);
    }
  }
}

function appendUnmatchedReply(
  history: HistoryMessage[],
  unmatchedReplies: Map<string, UnmatchedReply>,
  reply: QuestionReply
): void {
  // An imported or partial rollout may contain the reply but omit its tool call.
  const { toolUseId, questions } = reply.questionResponse;
  const unmatched = unmatchedReplies.get(toolUseId) ?? {
    index: history.length,
    fields: new Map<string, ReplyField>(),
  };
  for (const field of questions) {
    const id = field.id ?? '';
    if (!unmatched.fields.has(id)) {
      unmatched.fields.set(id, field);
    }
  }
  history[unmatched.index] = {
    ...reply,
    timestamp: history[unmatched.index]?.timestamp ?? reply.timestamp,
    questionResponse: {
      ...reply.questionResponse,
      status: 'unavailable',
      questions: [...unmatched.fields.values()].map((field) => ({ ...field, answers: [] })),
    },
  };
  unmatchedReplies.set(toolUseId, unmatched);
}

function appendQuestion(
  history: HistoryMessage[],
  question: PendingQuestion,
  unmatchedReplies: Map<string, UnmatchedReply>
): void {
  const unmatched = unmatchedReplies.get(question.toolUseId);
  if (!unmatched) {
    history.push(question.call);
    return;
  }
  foldAnswer(question, unmatched.fields.values());
  question.delivery = {
    index: unmatched.index,
    timestamp: history[unmatched.index]?.timestamp ?? question.call.timestamp,
  };
  history[unmatched.index] = projectQuestion(question);
  unmatchedReplies.delete(question.toolUseId);
}

function projectDeliveredReply(
  history: HistoryMessage[],
  replaced: Set<number>,
  pending: PendingQuestion,
  reply: QuestionReply
): void {
  foldAnswer(pending, reply.questionResponse.questions);
  if (pending.answers.size === 0) {
    history[pending.index] = projectQuestion(pending);
    return;
  }
  if (!pending.delivery) {
    pending.delivery = { index: history.length, timestamp: reply.timestamp };
    replaced.add(pending.index);
  }
  history[pending.delivery.index] = projectQuestion(pending);
}

/** Show an acknowledgment at the question and a completed answer at the first delivery. */
export function createCodexQuestionHistoryAppender(history: HistoryMessage[]) {
  const questions = new Map<string, PendingQuestion>();
  const unmatchedReplies = new Map<string, UnmatchedReply>();
  const replaced = new Set<number>();

  const append = (message: HistoryMessage): void => {
    if (message.type === 'question_response') {
      const pending = questions.get(message.questionResponse.toolUseId);
      if (pending) {
        projectDeliveredReply(history, replaced, pending, message);
      } else {
        appendUnmatchedReply(history, unmatchedReplies, message);
      }
      return;
    }

    const question = readQuestion(message, history.length);
    if (question) {
      if (!questions.has(question.toolUseId)) {
        questions.set(question.toolUseId, question);
        appendQuestion(history, question, unmatchedReplies);
      }
      return;
    }

    const pending =
      message.type === 'tool_result' && message.toolId ? questions.get(message.toolId) : undefined;
    if (
      pending &&
      typeof message.content === 'string' &&
      acknowledgment.safeParse(parseJson(message.content)).success
    ) {
      pending.acknowledgment = message.content;
      history[pending.delivery?.index ?? pending.index] = projectQuestion(pending);
      return;
    }
    history.push(message);
  };
  return {
    append,
    finish: () =>
      replaced.size > 0 ? history.filter((_, index) => !replaced.has(index)) : history,
  };
}
