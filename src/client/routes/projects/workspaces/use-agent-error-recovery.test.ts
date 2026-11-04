import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/chat-protocol';
import { findLastResendableUserMessage } from './use-agent-error-recovery';

function message(id: string, source: ChatMessage['source'], text?: string): ChatMessage {
  return { id, source, text, timestamp: '2026-09-17T00:00:00Z', order: Number(id.slice(-1)) };
}

describe('findLastResendableUserMessage', () => {
  it('returns the newest user message, skipping agent output', () => {
    const messages = [message('m1', 'user', 'First'), message('m2', 'agent')];
    expect(findLastResendableUserMessage(messages, new Set())?.id).toBe('m1');
  });

  it('skips queued and empty messages', () => {
    const messages = [
      message('m1', 'user', 'Sent'),
      message('m2', 'user', '   '),
      message('m3', 'user', 'Still queued'),
    ];
    expect(findLastResendableUserMessage(messages, new Set(['m3']))?.id).toBe('m1');
  });

  it('keeps attachment-only messages', () => {
    const attachmentOnly: ChatMessage = {
      ...message('m1', 'user'),
      attachments: [
        {
          id: 'image',
          name: 'screenshot.png',
          type: 'image/png',
          size: 3,
          data: 'abc',
        },
      ],
    };
    expect(findLastResendableUserMessage([attachmentOnly], new Set())?.id).toBe('m1');
  });

  it('returns null without a sent user message', () => {
    expect(findLastResendableUserMessage([message('m1', 'agent')], new Set())).toBeNull();
  });
});
