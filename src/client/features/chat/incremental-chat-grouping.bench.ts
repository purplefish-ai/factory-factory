import { test } from 'vitest';
import type { AgentMessage, ChatMessage } from '@/lib/chat-protocol';
import { groupAdjacentToolCalls } from '@/lib/chat-protocol';
import { createIncrementalChatGrouper } from './incremental-chat-grouping';

const timestamp = '2026-09-08T00:00:00.000Z';

function toolUse(index: number): ChatMessage {
  const message: AgentMessage = {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: `call-${index}`,
        name: 'Read',
        input: { file_path: `src/file-${index}.ts` },
      },
    },
  };
  return {
    id: `tool-use-${index}`,
    source: 'agent',
    message,
    timestamp,
    order: index * 3,
  };
}

function toolResult(index: number): ChatMessage {
  const message: AgentMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `call-${index}`,
          content: `result-${index}`,
          is_error: false,
        },
      ],
    },
  };
  return {
    id: `tool-result-${index}`,
    source: 'agent',
    message,
    timestamp,
    order: index * 3 + 1,
  };
}

function assistant(index: number, text: string): ChatMessage {
  return {
    id: `assistant-${index}`,
    source: 'agent',
    message: {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
    timestamp,
    order: index * 3 + 2,
  };
}

function createHistory(toolGroupCount: number): ChatMessage[] {
  return Array.from({ length: toolGroupCount }, (_, index) => [
    toolUse(index),
    toolResult(index),
    assistant(index, `completed-${index}`),
  ]).flat();
}

test('streaming a tail after 500 completed tool groups', async ({ bench }) => {
  const history = createHistory(500);
  let pureUpdate = 0;
  const grouper = createIncrementalChatGrouper();
  let incrementalUpdate = 0;
  grouper.group([...history, assistant(500, 'stream-0')]);

  await bench.compare(
    bench('pure full regroup', () => {
      pureUpdate += 1;
      groupAdjacentToolCalls([...history, assistant(500, `stream-${pureUpdate}`)]);
    }),
    bench('incremental tail regroup', () => {
      incrementalUpdate += 1;
      grouper.group([...history, assistant(500, `stream-${incrementalUpdate}`)]);
    })
  );
});
