import { describe, expect, it } from 'vitest';
import { parseCodexThreadReadTranscript } from './codex-thread-read-transcript';

describe('parseCodexThreadReadTranscript', () => {
  it('parses user and assistant messages from thread/read turns', () => {
    const transcript = parseCodexThreadReadTranscript({
      thread: {
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                type: 'userMessage',
                id: 'item-1',
                content: [{ type: 'text', text: 'hello' }],
              },
              {
                type: 'agentMessage',
                id: 'item-2',
                text: 'world',
              },
            ],
          },
        ],
      },
    });

    expect(transcript).toHaveLength(2);
    expect(transcript[0]).toMatchObject({
      id: 'codex-turn-1-item-1',
      source: 'user',
      text: 'hello',
      order: 0,
    });
    expect(transcript[1]).toMatchObject({
      id: 'codex-turn-1-item-2',
      source: 'claude',
      order: 1,
      message: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'world' }],
        },
      },
    });
  });

  it('supports PascalCase item types and content-based assistant text', () => {
    const transcript = parseCodexThreadReadTranscript({
      thread: {
        turns: [
          {
            id: 'turn-2',
            items: [
              {
                type: 'UserMessage',
                id: 'item-a',
                content: [{ type: 'text', text: 'question' }],
              },
              {
                type: 'AgentMessage',
                id: 'item-b',
                content: [{ type: 'text', text: 'answer' }],
              },
            ],
          },
        ],
      },
    });

    expect(transcript).toHaveLength(2);
    expect(transcript[0]).toMatchObject({ source: 'user', text: 'question', order: 0 });
    expect(transcript[1]).toMatchObject({
      source: 'claude',
      order: 1,
      message: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
        },
      },
    });
  });

  it('ignores unsupported item types and malformed payloads', () => {
    const transcript = parseCodexThreadReadTranscript({
      thread: {
        turns: [
          {
            id: 'turn-3',
            items: [
              { type: 'reasoning', id: 'skip-1' },
              { type: 'toolCall', id: 'skip-2' },
              { type: 'agentMessage', id: 'empty', text: '' },
            ],
          },
        ],
      },
    });

    expect(transcript).toHaveLength(0);
    expect(parseCodexThreadReadTranscript(null)).toEqual([]);
    expect(parseCodexThreadReadTranscript({})).toEqual([]);
  });
});
