import { describe, expect, it } from 'vitest';
import {
  CodexModelListResponseSchema,
  CodexTransportResponseSchema,
  parseCanonicalRequestIdWithSchema,
  parseNotificationTextWithSchema,
  parseToolCallNotificationWithSchema,
  parseToolResultNotificationWithSchema,
  parseTransportErrorWithSchema,
  parseUserInputQuestionsWithSchema,
  validateCodexApprovalResponseWithSchema,
  validateCodexRequestParamsWithSchema,
  validateCodexToolRequestUserInputResponseWithSchema,
} from './schemas';

describe('Codex schemas', () => {
  it('parses canonical request id from supported fields with fallback', () => {
    expect(parseCanonicalRequestIdWithSchema(1, { requestId: 'req-1' })).toBe('req-1');
    expect(parseCanonicalRequestIdWithSchema(2, { itemId: 'item-2' })).toBe('item-2');
    expect(parseCanonicalRequestIdWithSchema(3, { item: { id: 'nested-3' } })).toBe('nested-3');
    expect(parseCanonicalRequestIdWithSchema(4, { nope: true })).toBe('codex-request-4');
  });

  it('normalizes transport errors via schema parser with safe fallbacks', () => {
    expect(
      parseTransportErrorWithSchema({ code: 400, message: 'bad request', data: { x: 1 } })
    ).toEqual({
      code: 400,
      message: 'bad request',
      data: { x: 1 },
    });

    expect(parseTransportErrorWithSchema({ code: 'oops', message: '' })).toEqual({
      code: -1,
      message: 'Unknown Codex app-server error',
    });

    expect(parseTransportErrorWithSchema('boom')).toEqual({
      code: -1,
      message: 'boom',
    });
  });

  it('normalizes requestUserInput payloads with defaults', () => {
    expect(parseUserInputQuestionsWithSchema({ prompt: 'Need a choice?' })).toEqual([
      {
        header: 'Codex Input',
        question: 'Need a choice?',
        options: [
          {
            label: 'Continue',
            description: 'Provide an answer and continue execution.',
          },
          {
            label: 'Cancel',
            description: 'Decline and stop this request.',
          },
        ],
      },
    ]);

    expect(
      parseUserInputQuestionsWithSchema({
        prompt: 'default prompt',
        questions: [
          {
            header: '',
            question: '',
            options: [{ label: '', description: 12 }, {}],
          },
        ],
      })
    ).toEqual([
      {
        header: 'Codex Input',
        question: 'default prompt',
        options: [
          {
            label: 'Option',
            description: '',
          },
          {
            label: 'Option',
            description: '',
          },
        ],
      },
    ]);
  });

  it('requires result or error for transport responses', () => {
    expect(CodexTransportResponseSchema.safeParse({ id: 1 }).success).toBe(false);
    expect(CodexTransportResponseSchema.safeParse({ id: 1, result: {} }).success).toBe(true);
    expect(CodexTransportResponseSchema.safeParse({ id: 1, error: {} }).success).toBe(true);
  });

  it('accepts model/list payloads in both generated and documented field variants', () => {
    const parsed = CodexModelListResponseSchema.safeParse({
      data: [
        {
          id: 'gpt-5.2-codex',
          model: 'gpt-5.2-codex',
          upgrade: 'gpt-5.3-codex',
          displayName: 'GPT-5.2 Codex',
          defaultReasoningEffort: 'medium',
          reasoningEffort: [{ effort: 'low', description: 'Lower latency' }],
          supportsPersonality: true,
          isDefault: true,
        },
      ],
      nextCursor: null,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(parsed.data.data[0]).toMatchObject({
      supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Lower latency' }],
      inputModalities: ['text', 'image'],
    });
  });

  it('validates request params by method schema', () => {
    expect(
      validateCodexRequestParamsWithSchema('thread/read', {
        threadId: 'thread-1',
        includeTurns: true,
      })
    ).toEqual(
      expect.objectContaining({
        success: true,
      })
    );

    expect(
      validateCodexRequestParamsWithSchema('initialize', {
        clientInfo: { name: 'factory-factory', version: '0.2.8', title: null },
        capabilities: null,
      })
    ).toEqual(
      expect.objectContaining({
        success: true,
      })
    );

    expect(
      validateCodexRequestParamsWithSchema('initialize', {
        clientInfo: { name: 'factory-factory', version: '0.2.8', title: null },
      })
    ).toEqual(
      expect.objectContaining({
        success: false,
      })
    );

    expect(validateCodexRequestParamsWithSchema('thread/read', { includeTurns: true })).toEqual(
      expect.objectContaining({
        success: false,
      })
    );

    expect(validateCodexRequestParamsWithSchema('custom/method', { anything: true })).toEqual({
      success: true,
      data: { anything: true },
    });

    expect(
      validateCodexRequestParamsWithSchema('turn/start', {
        threadId: 'thread-1',
        input: [
          { type: 'text', text: 'hello', text_elements: [] },
          { type: 'skill', name: 'my-skill', path: '/tmp/skills/my-skill' },
        ],
        effort: null,
      })
    ).toEqual(
      expect.objectContaining({
        success: true,
      })
    );
  });

  it('extracts text and tool payloads with schema-based fallbacks', () => {
    expect(
      parseNotificationTextWithSchema({
        item: {
          message: {
            content: [{ text: 'hello from nested message' }],
          },
        },
      })
    ).toBe('hello from nested message');

    expect(
      parseNotificationTextWithSchema({
        text: '',
        delta: 'hello from delta',
      })
    ).toBe('hello from delta');

    expect(
      parseNotificationTextWithSchema({
        text: 123,
        chunk: 'hello from chunk',
      })
    ).toBe('hello from chunk');

    expect(parseToolCallNotificationWithSchema({ item: { id: 'tool-1', name: 'bash' } })).toEqual({
      toolUseId: 'tool-1',
      toolName: 'bash',
      input: {},
    });

    expect(
      parseToolCallNotificationWithSchema({
        toolUseId: '',
        toolName: 'bash',
        input: 'invalid',
        item: { id: 'tool-2' },
      })
    ).toEqual({
      toolUseId: 'tool-2',
      toolName: 'bash',
      input: {},
    });

    expect(
      parseToolResultNotificationWithSchema({
        item: { toolUseId: 'tool-1' },
        output: 'done',
      })
    ).toEqual({
      toolUseId: 'tool-1',
      output: 'done',
      payload: {
        item: { toolUseId: 'tool-1' },
        output: 'done',
      },
    });

    expect(
      parseToolResultNotificationWithSchema({
        toolUseId: '',
        item: { toolUseId: 'tool-3' },
        output: 42,
      })
    ).toEqual({
      toolUseId: 'tool-3',
      output: null,
      payload: {
        toolUseId: '',
        item: { toolUseId: 'tool-3' },
        output: 42,
      },
    });
  });

  it('validates approval and user-input response payloads', () => {
    expect(
      validateCodexApprovalResponseWithSchema('item/commandExecution/requestApproval', {
        decision: 'accept',
      })
    ).toEqual({
      success: true,
      data: {
        decision: 'accept',
      },
    });

    expect(
      validateCodexApprovalResponseWithSchema('applyPatchApproval', {
        decision: 'decline',
      })
    ).toEqual({
      success: true,
      data: {
        decision: 'decline',
      },
    });

    expect(
      validateCodexApprovalResponseWithSchema('execCommandApproval', {
        decision: 'accept',
      })
    ).toEqual({
      success: true,
      data: {
        decision: 'accept',
      },
    });

    expect(
      validateCodexToolRequestUserInputResponseWithSchema({
        answers: {
          question_1: {
            answers: ['yes'],
          },
        },
      })
    ).toEqual({
      success: true,
      data: {
        answers: {
          question_1: {
            answers: ['yes'],
          },
        },
      },
    });
  });
});
