import { describe, expect, it } from 'vitest';
import { ChatMessageSchema } from './chat-message.schema';

describe('ChatMessageSchema', () => {
  it('accepts queue_message with attachments and settings', () => {
    const result = ChatMessageSchema.safeParse({
      type: 'queue_message',
      id: 'msg-1',
      text: 'Hello',
      attachments: [
        {
          id: 'att-1',
          name: 'note.txt',
          type: 'text/plain',
          size: 12,
          data: 'SGVsbG8=',
        },
      ],
      settings: {
        selectedModel: 'opus',
        thinkingEnabled: false,
        planModeEnabled: true,
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects queue_message without id', () => {
    const result = ChatMessageSchema.safeParse({
      type: 'queue_message',
      text: 'missing id',
    });

    expect(result.success).toBe(false);
  });

  it('accepts question_response with multi-select answers', () => {
    const result = ChatMessageSchema.safeParse({
      type: 'question_response',
      requestId: 'req-1',
      answers: {
        question1: ['a', 'b'],
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts set_thinking_budget with null', () => {
    const result = ChatMessageSchema.safeParse({
      type: 'set_thinking_budget',
      max_tokens: null,
    });

    expect(result.success).toBe(true);
  });

  it('accepts rewind_files with optional dryRun', () => {
    const result = ChatMessageSchema.safeParse({
      type: 'rewind_files',
      userMessageId: 'user-msg-123',
      dryRun: true,
    });

    expect(result.success).toBe(true);
  });

  it('accepts load_session with optional loadRequestId', () => {
    const result = ChatMessageSchema.safeParse({
      type: 'load_session',
      loadRequestId: 'load-123',
    });

    expect(result.success).toBe(true);
  });

  it('accepts resume_queued_messages', () => {
    const result = ChatMessageSchema.safeParse({
      type: 'resume_queued_messages',
    });

    expect(result.success).toBe(true);
  });
});
