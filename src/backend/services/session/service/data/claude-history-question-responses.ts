import { z } from 'zod';
import type { HistoryMessage } from '@/shared/acp-protocol';
import {
  type QuestionResponse,
  buildQuestionToolDetails,
} from '@/shared/acp-protocol/protocol/question-response';
import { getAskUserQuestions } from '@/shared/acp-protocol/question-input';
import { summarizeQuestionResponse } from '@/shared/acp-protocol/question-response-summary';

type Call = Extract<HistoryMessage, { type: 'tool_use' }>;
type ToolResult = Extract<HistoryMessage, { type: 'tool_result' }>;
type Response = Extract<HistoryMessage, { type: 'question_response' }>;
export type ClaudeQuestionCallIndex = Map<string, { index: number; call: Call }>;

const structuredQuestionResultSchema = z.object({
  questions: z.array(z.unknown()).min(1),
  answers: z
    .record(
      z.string(),
      z.union([z.string().transform((value) => (value ? [value] : [])), z.array(z.string())])
    )
    .optional()
    .catch(undefined),
  annotations: z
    .record(
      z.string(),
      z.object({ notes: z.string().trim().min(1).optional().catch(undefined) }).catch({})
    )
    .optional()
    .catch(undefined),
});

function statusOf(result: ToolResult): QuestionResponse['status'] {
  if (!result.isError) {
    return 'answered';
  }
  const cancellation =
    /^(?:(?:cancelled|canceled|declined)[.!]?$|The user doesn't want to proceed with this tool use\. The tool use was rejected)/i;
  return typeof result.content === 'string' && cancellation.test(result.content.trim())
    ? 'cancelled'
    : 'unavailable';
}

function readStructuredSubmission(input: Record<string, unknown>, structuredResult: unknown) {
  const structured = structuredQuestionResultSchema.safeParse(structuredResult).data;
  const reported = getAskUserQuestions(structured);
  const expected = getAskUserQuestions(input);
  return expected.length === reported.length &&
    expected.every((field, index) => field.question === reported[index]?.question)
    ? structured
    : undefined;
}

function completedQuestion(
  call: Call,
  result: ToolResult,
  toolUseId: string,
  structuredResult: unknown
): Response {
  const status = statusOf(result);
  const input = call.toolInput ?? {};
  const submitted =
    status === 'answered' ? readStructuredSubmission(input, structuredResult) : undefined;
  const answerPairs = getAskUserQuestions(input).flatMap(({ id, question }) => {
    const answers = submitted?.answers;
    return answers && Object.hasOwn(answers, question)
      ? [[id?.trim() || question, answers[question] ?? []] as const]
      : [];
  });
  const questionResponse = summarizeQuestionResponse(
    input,
    { toolUseId },
    status,
    Object.fromEntries(answerPairs)
  );
  const annotations = submitted?.annotations;
  questionResponse.questions = questionResponse.questions.map((field) => {
    const note =
      annotations && Object.hasOwn(annotations, field.question)
        ? annotations[field.question]?.notes
        : undefined;
    return note && !field.redacted ? { ...field, note } : field;
  });
  const details = questionResponse.questions.some((question) => question.redacted)
    ? undefined
    : buildQuestionToolDetails(call.toolName ?? 'AskUserQuestion', input, result.content);
  return {
    type: 'question_response',
    content: call.content,
    timestamp: call.timestamp,
    uuid: call.uuid,
    questionResponse,
    ...(details ? { questionToolDetails: details } : {}),
  };
}

function isQuestionCall(message: HistoryMessage): message is Call & { toolId: string } {
  return (
    message.type === 'tool_use' && message.toolName === 'AskUserQuestion' && Boolean(message.toolId)
  );
}

function resultQuality(response: Response): number {
  const { status, questions } = response.questionResponse;
  if (questions.some(({ answers, note }) => answers.length > 0 || note)) {
    return 3;
  }
  if (status === 'cancelled') {
    return 2;
  }
  return status === 'answered' ? 1 : 0;
}

function replaceQuestionWithResult(
  history: HistoryMessage[],
  questionCalls: ClaudeQuestionCallIndex,
  result: ToolResult,
  structuredResult: unknown
): boolean {
  const toolId = result.toolId;
  const entry = toolId ? questionCalls.get(toolId) : undefined;
  if (!(toolId && entry)) {
    return false;
  }
  const { index, call } = entry;
  const previous = history[index];
  const completed = completedQuestion(call, result, toolId, structuredResult);
  if (
    previous?.type !== 'question_response' ||
    resultQuality(completed) > resultQuality(previous)
  ) {
    history[index] = completed;
  }
  return true;
}

/** Keep the first position if Claude repeats a progressively enriched tool call. */
function rememberQuestionCall(
  history: HistoryMessage[],
  questionCalls: ClaudeQuestionCallIndex,
  message: Call & { toolId: string }
): void {
  const previous = questionCalls.get(message.toolId);
  if (!previous) {
    questionCalls.set(message.toolId, { index: history.length, call: message });
    history.push(message);
    return;
  }
  if (
    history[previous.index]?.type === 'tool_use' &&
    getAskUserQuestions(message.toolInput).length > 0
  ) {
    const call = { ...previous.call, toolInput: message.toolInput };
    questionCalls.set(message.toolId, { index: previous.index, call });
    history[previous.index] = call;
  }
}

/** The top-level Claude result belongs to the single tool result in this record. */
export function appendHistoryWithQuestionResponses(
  history: HistoryMessage[],
  questionCalls: ClaudeQuestionCallIndex,
  messages: HistoryMessage[],
  structuredResult: unknown
): void {
  const singleResult = messages.filter((message) => message.type === 'tool_result').length === 1;
  for (const message of messages) {
    if (isQuestionCall(message)) {
      rememberQuestionCall(history, questionCalls, message);
      continue;
    }
    if (
      message.type === 'tool_result' &&
      replaceQuestionWithResult(
        history,
        questionCalls,
        message,
        singleResult ? structuredResult : undefined
      )
    ) {
      continue;
    }
    history.push(message);
  }
}
