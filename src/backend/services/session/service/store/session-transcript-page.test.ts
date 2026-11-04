import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/shared/acp-protocol';
import { selectTranscriptPage } from './session-transcript-page';

function message(order: number): ChatMessage {
  return {
    id: `m-${order}`,
    source: 'user',
    text: `${order}`,
    order,
    timestamp: '2026-11-04T00:00:00Z',
  };
}

describe('transcript history pages', () => {
  it('pages backwards by stable identity despite appended live messages', () => {
    const transcript = Array.from({ length: 1205 }, (_, order) => message(order));
    const page = selectTranscriptPage(transcript, 'm-1000');
    expect(page.messages).toHaveLength(500);
    expect(page.messages[0]?.id).toBe('m-500');
    expect(page.messages.at(-1)?.id).toBe('m-999');
    expect(page.hasMore).toBe(true);
    const first = selectTranscriptPage(transcript, page.messages[0]?.id ?? '');
    expect(first.messages.map((entry) => entry.id)).toEqual(
      transcript.slice(0, 500).map((entry) => entry.id)
    );
    expect(first.hasMore).toBe(false);
    expect(transcript).toHaveLength(1205);
  });

  it('returns an empty final page for the beginning', () => {
    expect(selectTranscriptPage([message(0)], 'm-0')).toEqual({ messages: [], hasMore: false });
  });

  it('rejects an expired cursor instead of silently omitting messages', () => {
    expect(() => selectTranscriptPage([message(0)], 'missing')).toThrow('history has changed');
  });

  it('starts safely and leaves skipped stream fragments available on the previous page', () => {
    const transcript = Array.from({ length: 505 }, (_, order) => message(order));
    transcript[4] = {
      ...message(4),
      source: 'agent',
      message: { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    };
    const page = selectTranscriptPage(transcript, 'm-504');
    expect(page.messages[0]?.id).toBe('m-5');
    const earlier = selectTranscriptPage(transcript, 'm-5');
    expect(earlier.messages.map((entry) => entry.id)).toEqual(['m-0', 'm-1', 'm-2', 'm-3', 'm-4']);
  });
});
