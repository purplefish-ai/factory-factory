import type { AgentMessage, ChatMessage, ToolResultContentValue } from '@/shared/acp-protocol';
import {
  type QuestionResponse,
  buildQuestionToolDetails,
} from '@/shared/acp-protocol/protocol/question-response';
import { hasSecretQuestion } from '@/shared/acp-protocol/question-input';
import { mergeLifecycleMessage } from './session-lifecycle-transcript';
import type { SessionStore } from './session-store.types';
import { getTranscriptToolEntries } from './session-tool-use-index';
import { upsertTranscriptMessage } from './session-transcript';

export type QuestionMessage = Extract<AgentMessage, { type: 'question_response' }>;

function questionResponseMessageId(toolUseId: string): string {
  return `question-response:${toolUseId}`;
}

function getToolStart(message: AgentMessage | undefined) {
  const event = message?.event;
  const block = event?.type === 'content_block_start' ? event.content_block : undefined;
  return block?.type === 'tool_use' ? block : undefined;
}

/** A result can replace its row only when that row contains no unrelated content. */
function getStandaloneToolResult(message: AgentMessage | undefined) {
  const event = message?.event;
  const block = event?.type === 'content_block_start' ? event.content_block : undefined;
  if (block?.type === 'tool_result') {
    return block;
  }
  const content = message?.message?.content;
  const item = Array.isArray(content) && content.length === 1 ? content[0] : undefined;
  return item?.type === 'tool_result' ? item : undefined;
}

function getQuestionAnchorId(message: AgentMessage | undefined): string | undefined {
  return message?.type === 'question_response'
    ? message.questionResponse.toolUseId
    : getToolStart(message)?.id;
}

function isFallbackAnchor(rowId: string, toolUseId: string): boolean {
  return rowId === questionResponseMessageId(toolUseId);
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
  const anchors = matching.filter(({ message }) => getQuestionAnchorId(message) === toolUseId);
  const anchor = anchors.find(({ id }) => !isFallbackAnchor(id, toolUseId)) ?? anchors[0];
  const result = matching.reduce<ToolResultContentValue | undefined>((latest, { message }) => {
    const block = getStandaloneToolResult(message);
    return block?.tool_use_id === toolUseId ? block.content : latest;
  }, undefined);
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
        (entry) =>
          entry.id !== row.id &&
          (getQuestionAnchorId(entry.message) === toolUseId ||
            getStandaloneToolResult(entry.message)?.tool_use_id === toolUseId)
      )
      .map((entry) => entry.id),
  };
}

/** ACP may enrich the tool or return its result after the answer already replaced the call. */
export function foldQuestionToolUpdate(
  store: SessionStore,
  message: AgentMessage
): { messageId: string; order: number; replacement: QuestionMessage } | undefined {
  const result = getStandaloneToolResult(message);
  const toolId = getToolStart(message)?.id ?? result?.tool_use_id;
  if (!toolId) {
    return undefined;
  }
  const entry = getTranscriptToolEntries(store, toolId).find(
    (item) => item.message?.type === 'question_response'
  );
  if (entry?.message?.type !== 'question_response') {
    return undefined;
  }
  const replacement = result ? addQuestionResult(entry.message, result.content) : entry.message;
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
  const block = getToolStart(message);
  if (!(block && answersByTool.has(block.id))) {
    return undefined;
  }
  return {
    toolUseId: block.id,
    details: hasSecretQuestion(block.input)
      ? undefined
      : buildQuestionToolDetails(block.name, block.input),
  };
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
    if (!currentAnchor || isFallbackAnchor(currentAnchor, anchor.toolUseId)) {
      anchorIds.set(anchor.toolUseId, row.id);
      detailsByTool.set(anchor.toolUseId, anchor.details);
    }
  }

  const matched = transcript
    .flatMap((row) => {
      const result = getStandaloneToolResult(row.message);
      if (result && answersByTool.has(result.tool_use_id)) {
        const details = detailsByTool.get(result.tool_use_id);
        if (details) {
          detailsByTool.set(result.tool_use_id, { ...details, result: result.content });
        }
        return [];
      }
      return [row];
    })
    .flatMap((row): ChatMessage[] => {
      const id = getQuestionAnchorId(row.message);
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
