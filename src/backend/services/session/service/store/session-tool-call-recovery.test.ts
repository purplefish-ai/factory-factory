import { describe, expect, it } from 'vitest';
import { groupAdjacentToolCalls, isToolSequence } from '@/lib/chat-protocol';
import type { ChatMessage } from '@/shared/acp-protocol';
import { finalizeInterruptedTranscriptToolCalls } from './session-tool-call-recovery';

function toolUse(messageId: string, order: number): ChatMessage {
  return {
    id: messageId,
    source: 'agent',
    timestamp: `2026-08-20T10:00:0${order}.000Z`,
    order,
    message: {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'reused-call-id',
          name: 'exec_command',
          input: { cmd: `command-${order}` },
        },
      },
    },
  };
}

function assistantMessage(order: number): ChatMessage {
  return {
    id: `assistant-${order}`,
    source: 'agent',
    timestamp: `2026-08-20T10:00:0${order}.000Z`,
    order,
    message: {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Continuing.' }] },
    },
  };
}

function toolResult(order: number): ChatMessage {
  return {
    id: `tool-result-${order}`,
    source: 'agent',
    timestamp: `2026-08-20T10:00:0${order}.000Z`,
    order,
    message: {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'reused-call-id', content: 'done' }],
      },
    },
  };
}

describe('finalizeInterruptedTranscriptToolCalls', () => {
  it('finalizes every unmatched occurrence when a tool ID was reused', () => {
    const recovered = finalizeInterruptedTranscriptToolCalls(
      [toolUse('tool-use-1', 0), toolUse('tool-use-2', 1)],
      '2026-08-20T10:01:00.000Z'
    );

    const toolSequences = groupAdjacentToolCalls(recovered).filter(isToolSequence);
    expect(toolSequences).toHaveLength(1);
    expect(toolSequences[0]?.pairedCalls.map((call) => call.status)).toEqual(['error', 'error']);
  });

  it('matches a real result to the earlier occurrence of a reused tool ID', () => {
    const recovered = finalizeInterruptedTranscriptToolCalls(
      [toolUse('tool-use-1', 0), toolResult(1), assistantMessage(2), toolUse('tool-use-2', 3)],
      '2026-08-20T10:01:00.000Z'
    );

    const toolSequences = groupAdjacentToolCalls(recovered).filter(isToolSequence);
    expect(toolSequences.map((sequence) => sequence.pairedCalls[0]?.status)).toEqual([
      'success',
      'error',
    ]);
  });

  it('keeps a real result on the earlier occurrence when recovering the later one', () => {
    const recovered = finalizeInterruptedTranscriptToolCalls(
      [toolUse('tool-use-1', 0), assistantMessage(1), toolUse('tool-use-2', 2), toolResult(3)],
      '2026-08-20T10:01:00.000Z'
    );

    const toolSequences = groupAdjacentToolCalls(recovered).filter(isToolSequence);
    expect(toolSequences.map((sequence) => sequence.pairedCalls[0]?.status)).toEqual([
      'success',
      'error',
    ]);
  });

  it('does not add another result when recovery is applied twice', () => {
    const firstRecovery = finalizeInterruptedTranscriptToolCalls(
      [toolUse('tool-use-1', 0)],
      '2026-08-20T10:01:00.000Z'
    );

    const secondRecovery = finalizeInterruptedTranscriptToolCalls(
      firstRecovery,
      '2026-08-20T10:02:00.000Z'
    );

    expect(secondRecovery).toBe(firstRecovery);
  });
});
