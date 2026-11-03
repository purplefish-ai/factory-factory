import { test } from 'vitest';
import { createIncrementalChatGrouper } from '@/client/features/chat/incremental-chat-grouping';
import type { AgentMessage, ChatMessage } from '@/lib/chat-protocol';
import { DEFAULT_RENDERER_TRANSCRIPT_LIMIT } from '@/lib/chat-protocol';
import { type ChatState, chatReducer, createInitialChatState } from './index';

const timestamp = '2026-11-03T00:00:00.000Z';

/** Tool use, tool result, assistant text: one tool turn per three orders. */
function agentMessage(order: number): AgentMessage {
  const turn = Math.floor(order / 3);
  switch (order % 3) {
    case 0:
      return {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: `call-${turn}`,
            name: 'Read',
            input: { file_path: `src/file-${turn}.ts` },
          },
        },
      };
    case 1:
      return {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: `call-${turn}`, content: 'ok', is_error: false },
          ],
        },
      };
    default:
      return {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `done ${turn}` }] },
      };
  }
}

function fullWindow(): ChatState {
  const messages: ChatMessage[] = Array.from(
    { length: DEFAULT_RENDERER_TRANSCRIPT_LIMIT },
    (_, order) => ({
      id: `message-${order}`,
      source: 'agent',
      message: agentMessage(order),
      timestamp,
      order,
    })
  );
  return chatReducer(createInitialChatState(), {
    type: 'SESSION_SNAPSHOT',
    payload: {
      messages,
      queuedMessages: [],
      sessionRuntime: {
        phase: 'running',
        processState: 'alive',
        activity: 'WORKING',
        updatedAt: timestamp,
      },
    },
  });
}

test('appending to a full renderer window', async ({ bench }) => {
  let state = fullWindow();
  let order = state.messages.length;
  const grouper = createIncrementalChatGrouper({ filterDuplicateResults: true });
  grouper.group(state.messages);

  await bench('reducer append and regroup', () => {
    state = chatReducer(state, {
      type: 'WS_AGENT_MESSAGE',
      payload: { message: agentMessage(order), order, messageId: `message-${order}` },
    });
    order += 1;
    grouper.group(state.messages);
  }).run();
});
