import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionDeltaEvent } from '@/shared/acp-protocol';
import { AcpEventTranslator } from '@/shared/acp-protocol/session-update-translator';
import { AcpThoughtBuffer } from './acp-thought-buffer';

function thought(text: string, index = 0): SessionDeltaEvent {
  return {
    type: 'agent_message',
    data: {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: text },
      },
    },
  };
}

function emittedText(emit: ReturnType<typeof vi.fn>): string[] {
  return emit.mock.calls.map(([, delta]) => delta.data.event.delta.thinking);
}

describe('AcpThoughtBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('merges chunks that arrive within the interval into one delta', () => {
    const emit = vi.fn();
    const buffer = new AcpThoughtBuffer(emit, 25);

    expect(buffer.push('s1', thought('Let '))).toBe(true);
    buffer.push('s1', thought('me '));
    buffer.push('s1', thought('think'));
    expect(emit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(25);
    expect(emittedText(emit)).toEqual(['Let me think']);
    expect(emit.mock.calls[0]?.[0]).toBe('s1');
  });

  it('flushes on demand so later deltas keep their order', () => {
    const emit = vi.fn();
    const buffer = new AcpThoughtBuffer(emit, 25);

    buffer.push('s1', thought('a'));
    buffer.flush('s1');
    vi.advanceTimersByTime(25);

    expect(emittedText(emit)).toEqual(['a']);
  });

  it('starts a new delta when the content block index changes', () => {
    const emit = vi.fn();
    const buffer = new AcpThoughtBuffer(emit, 25);

    buffer.push('s1', thought('first', 0));
    buffer.push('s1', thought('second', 1));
    vi.advanceTimersByTime(25);

    expect(emit.mock.calls.map(([, delta]) => delta.data.event.index)).toEqual([0, 1]);
    expect(emittedText(emit)).toEqual(['first', 'second']);
  });

  it('keeps sessions separate', () => {
    const emit = vi.fn();
    const buffer = new AcpThoughtBuffer(emit, 25);

    buffer.push('s1', thought('one'));
    buffer.push('s2', thought('two'));
    vi.advanceTimersByTime(25);

    expect(emit.mock.calls.map(([sessionId]) => sessionId).sort()).toEqual(['s1', 's2']);
  });

  it('accepts the thought deltas the ACP translator produces', () => {
    const translator = new AcpEventTranslator({ warn: vi.fn() });
    const [delta] = translator.translateSessionUpdate(
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
      's1'
    );
    const buffer = new AcpThoughtBuffer(vi.fn(), 25);

    expect(delta && buffer.push('s1', delta)).toBe(true);
  });

  it('passes through anything that is not a plain thought chunk', () => {
    const buffer = new AcpThoughtBuffer(vi.fn(), 25);
    const text: SessionDeltaEvent = {
      type: 'agent_message',
      data: {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      },
    };
    const withExtraField = {
      ...thought('x'),
      data: { ...(thought('x') as { data: object }).data, parent_tool_use_id: 'tool-1' },
    } as SessionDeltaEvent;

    expect(buffer.push('s1', text)).toBe(false);
    expect(buffer.push('s1', withExtraField)).toBe(false);
  });
});
