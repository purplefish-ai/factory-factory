import type { ChatMessage } from '@/shared/acp-protocol';

type OpenToolCall = {
  hasResult: boolean;
  messageId: string;
  occurrence: number;
  toolUseId: string;
};

function getToolUseIds(message: ChatMessage): string[] {
  if (message.source !== 'agent' || !message.message) {
    return [];
  }

  const agentMessage = message.message;
  if (
    agentMessage.type === 'stream_event' &&
    agentMessage.event?.type === 'content_block_start' &&
    agentMessage.event.content_block.type === 'tool_use'
  ) {
    return [agentMessage.event.content_block.id];
  }

  const content = agentMessage.message?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((item) => (item.type === 'tool_use' ? [item.id] : []));
}

function getToolResultIds(message: ChatMessage): string[] {
  if (message.source !== 'agent' || !message.message) {
    return [];
  }

  const agentMessage = message.message;
  if (
    agentMessage.type === 'stream_event' &&
    agentMessage.event?.type === 'content_block_start' &&
    agentMessage.event.content_block.type === 'tool_result'
  ) {
    return [agentMessage.event.content_block.tool_use_id];
  }

  const content = agentMessage.message?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((item) => (item.type === 'tool_result' ? [item.tool_use_id] : []));
}

export function finalizeInterruptedTranscriptToolCalls(
  transcript: ChatMessage[],
  timestamp: string
): ChatMessage[] {
  const openToolCallsById = new Map<string, OpenToolCall[]>();
  const toolCalls: OpenToolCall[] = [];
  for (const message of transcript) {
    for (const toolUseId of getToolUseIds(message)) {
      const toolCall = {
        hasResult: false,
        messageId: message.id,
        occurrence: toolCalls.length,
        toolUseId,
      };
      toolCalls.push(toolCall);
      const occurrences = openToolCallsById.get(toolUseId) ?? [];
      occurrences.push(toolCall);
      openToolCallsById.set(toolUseId, occurrences);
    }
    for (const toolResultId of getToolResultIds(message)) {
      const occurrences = openToolCallsById.get(toolResultId);
      const completedToolCall = occurrences?.shift();
      if (completedToolCall) {
        completedToolCall.hasResult = true;
      }
      if (occurrences?.length === 0) {
        openToolCallsById.delete(toolResultId);
      }
    }
  }

  if (openToolCallsById.size === 0) {
    return transcript;
  }

  let nextOrder = transcript.reduce((maximum, message) => Math.max(maximum, message.order), -1) + 1;
  const recoveredResults = toolCalls
    .filter((toolCall) => !toolCall.hasResult)
    .map((toolCall): ChatMessage => {
      const recoveredResult: ChatMessage = {
        id: `recovered-tool-result:${toolCall.messageId}:${toolCall.toolUseId}:${toolCall.occurrence}`,
        source: 'agent',
        timestamp,
        order: nextOrder,
        message: {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolCall.toolUseId,
                content: 'Tool call was interrupted before it returned a result.',
                is_error: true,
              },
            ],
          },
        },
      };
      nextOrder += 1;
      return recoveredResult;
    });

  return [...transcript, ...recoveredResults];
}
