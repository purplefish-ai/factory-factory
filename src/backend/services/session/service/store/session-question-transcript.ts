import type { AgentMessage, ChatMessage, ToolResultContentValue } from '@/shared/acp-protocol';
import {
  type QuestionResponse,
  buildQuestionToolDetails,
} from '@/shared/acp-protocol/protocol/question-response';
import { mergeLifecycleMessage } from './session-lifecycle-transcript';
import type { SessionStore } from './session-store.types';
import { getTranscriptToolEntries } from './session-tool-use-index';
import { upsertTranscriptMessage } from './session-transcript';

export type QuestionMessage = Extract<AgentMessage, { type: 'question_response' }>;

function questionResponseMessageId(toolUseId: string): string {
  return `question-response:${toolUseId}`;
}

function getQuestionResult(message: AgentMessage | undefined, toolUseId: string) {
  const event = message?.event;
  if (event?.type === 'content_block_start' && event.content_block.type === 'tool_result') {
    return event.content_block.tool_use_id === toolUseId ? event.content_block.content : undefined;
  }
  const content = message?.message?.content;
  const item = Array.isArray(content)
    ? content.find((item) => item.type === 'tool_result' && item.tool_use_id === toolUseId)
    : undefined;
  return item?.type === 'tool_result' ? item.content : undefined;
}

function addQuestionResult(
  message: QuestionMessage,
  result: ToolResultContentValue
): QuestionMessage {
  if (
    !message.questionToolDetails ||
    message.questionResponse.questions.some((item) => item.redacted)
  ) {
    return message;
  }
  return { ...message, questionToolDetails: { ...message.questionToolDetails, result } };
}

export function recordQuestionResponse(
  store: SessionStore,
  order: number,
  data: QuestionMessage,
  timestamp: string
): { row: ChatMessage; obsoleteIds: string[] } {
  const { toolUseId } = data.questionResponse;
  const matching = getTranscriptToolEntries(store, toolUseId);
  const anchor = matching.find(
    (entry) =>
      entry.message?.type === 'question_response' ||
      (entry.message?.event?.type === 'content_block_start' &&
        entry.message.event.content_block.type === 'tool_use')
  );
  const result = matching
    .map(({ message }) => getQuestionResult(message, toolUseId))
    .find((value) => value !== undefined);
  const message = result === undefined ? data : addQuestionResult(data, result);
  const row: ChatMessage = {
    id: anchor?.id ?? questionResponseMessageId(toolUseId),
    order: anchor?.order ?? order,
    source: 'agent',
    timestamp: anchor?.timestamp ?? timestamp,
    message: { ...message, timestamp: anchor?.timestamp ?? timestamp },
  };
  upsertTranscriptMessage(store, row);
  return {
    row,
    obsoleteIds: matching
      .filter(
        (entry) => entry.id !== row.id && getQuestionResult(entry.message, toolUseId) !== undefined
      )
      .map((entry) => entry.id),
  };
}

/** ACP may enrich the tool or return its result after the answer already replaced the call. */
export function foldQuestionToolUpdate(
  store: SessionStore,
  message: AgentMessage
): { messageId: string; order: number; replacement: QuestionMessage } | undefined {
  const event = message.event;
  const block = event?.type === 'content_block_start' ? event.content_block : undefined;
  const content = message.message?.content;
  const toolId =
    block?.type === 'tool_use'
      ? block.id
      : block?.type === 'tool_result'
        ? block.tool_use_id
        : Array.isArray(content) && content.length === 1 && content[0]?.type === 'tool_result'
          ? content[0].tool_use_id
          : undefined;
  if (!toolId) {
    return undefined;
  }
  const entry = getTranscriptToolEntries(store, toolId).find(
    (item) => item.message?.type === 'question_response'
  );
  if (entry?.message?.type !== 'question_response') {
    return undefined;
  }
  const result = getQuestionResult(message, toolId);
  const replacement =
    result === undefined ? entry.message : addQuestionResult(entry.message, result);
  upsertTranscriptMessage(store, { ...entry, message: replacement });
  return { messageId: entry.id, order: entry.order, replacement };
}

function questionHistoryAnchor(
  row: ChatMessage,
  answersByTool: ReadonlyMap<string, QuestionResponse>
): { toolUseId: string; details: QuestionMessage['questionToolDetails'] } | undefined {
  const message = row.message;
  if (message?.type === 'question_response') {
    return { toolUseId: message.questionResponse.toolUseId, details: message.questionToolDetails };
  }
  const event = message?.event;
  const block = event?.type === 'content_block_start' ? event.content_block : undefined;
  if (block?.type !== 'tool_use' || !answersByTool.has(block.id)) {
    return undefined;
  }
  return { toolUseId: block.id, details: buildQuestionToolDetails(block.name, block.input) };
}

/** Durable summaries win over provider reconstruction. Correlated rows keep provider order. */
export function mergeQuestionResponseHistory(
  transcript: ChatMessage[],
  restored: Array<{ summary: QuestionResponse; timestamp: string }>
): ChatMessage[] {
  if (restored.length === 0) {
    return transcript;
  }
  const answersByTool = new Map(restored.map(({ summary }) => [summary.toolUseId, summary]));
  const anchorIds = new Map<string, string>();
  const detailsByTool = new Map<string, QuestionMessage['questionToolDetails']>();
  for (const row of transcript) {
    const anchor = questionHistoryAnchor(row, answersByTool);
    if (!(anchor && answersByTool.has(anchor.toolUseId))) {
      continue;
    }
    const currentAnchor = anchorIds.get(anchor.toolUseId);
    if (!currentAnchor || currentAnchor === questionResponseMessageId(anchor.toolUseId)) {
      anchorIds.set(anchor.toolUseId, row.id);
      detailsByTool.set(anchor.toolUseId, anchor.details);
    }
  }

  const matched = transcript
    .flatMap((row) => {
      const message = row.message;
      const event = message?.event;
      const block = event?.type === 'content_block_start' ? event.content_block : undefined;
      const content = message?.message?.content;
      const resultId =
        block?.type === 'tool_result'
          ? block.tool_use_id
          : Array.isArray(content) && content.length === 1 && content[0]?.type === 'tool_result'
            ? content[0].tool_use_id
            : undefined;
      if (resultId && answersByTool.has(resultId)) {
        const details = detailsByTool.get(resultId);
        const result = getQuestionResult(message, resultId);
        if (details && result !== undefined) {
          detailsByTool.set(resultId, { ...details, result });
        }
        return [];
      }
      return [row];
    })
    .flatMap((row): ChatMessage[] => {
      const message = row.message;
      const event = message?.event;
      const tool =
        event?.type === 'content_block_start' && event.content_block.type === 'tool_use'
          ? event.content_block
          : undefined;
      const id =
        message?.type === 'question_response' ? message.questionResponse.toolUseId : tool?.id;
      const summary = id ? answersByTool.get(id) : undefined;
      if (!(id && summary)) {
        return [row];
      }
      if (anchorIds.get(id) !== row.id) {
        return [];
      }
      return [
        {
          ...row,
          message: {
            type: 'question_response',
            timestamp: row.timestamp,
            questionResponse: summary,
            questionToolDetails: summary.questions.some((item) => item.redacted)
              ? undefined
              : detailsByTool.get(id),
          },
        },
      ];
    });

  const unmatched = restored
    .filter(({ summary }) => !anchorIds.has(summary.toolUseId))
    .map(({ summary, timestamp }): ChatMessage => ({
      id: questionResponseMessageId(summary.toolUseId),
      order: 0,
      source: 'agent',
      timestamp,
      message: { type: 'question_response', questionResponse: summary, timestamp },
    }));
  return unmatched.length > 0 ? mergeLifecycleMessage(matched, unmatched) : matched;
}
