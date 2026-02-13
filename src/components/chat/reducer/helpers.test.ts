import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/chat-protocol';
import { insertMessageByOrder } from './helpers';

function makeUserMessage(id: string, order: number): ChatMessage {
  return {
    id,
    source: 'user',
    text: `message-${id}`,
    timestamp: '2026-02-09T00:00:00.000Z',
    order,
  };
}

describe('insertMessageByOrder', () => {
  it('inserts message at correct sorted position', () => {
    const messages = [makeUserMessage('a', 1), makeUserMessage('c', 3)];
    const inserted = insertMessageByOrder(messages, makeUserMessage('b', 2));

    expect(inserted.map((message) => message.id)).toEqual(['a', 'b', 'c']);
  });

  it('throws when binary-search mid index resolves to a missing message', () => {
    const sparseMessages = [undefined, makeUserMessage('c', 3)] as unknown as ChatMessage[];

    expect(() => insertMessageByOrder(sparseMessages, makeUserMessage('b', 2))).toThrow(
      'Missing message at index'
    );
  });
});
