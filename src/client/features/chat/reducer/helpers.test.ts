import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/chat-protocol';
import type { PendingInteractiveRequest } from '@/shared/pending-request-types';
import { convertPendingRequest, insertMessageByOrder } from './helpers';

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

describe('convertPendingRequest', () => {
  it('maps AskUserQuestion tool requests to question prompts', () => {
    const acpOptions = [{ optionId: 'answer_0', name: 'A', kind: 'allow_once' as const }];
    const request: PendingInteractiveRequest = {
      requestId: 'req-1',
      toolName: 'AskUserQuestion',
      toolUseId: 'tool-1',
      input: {
        questions: [{ question: 'Pick one', options: [{ label: 'A', description: 'a' }] }],
      },
      planContent: null,
      acpOptions,
      timestamp: '2026-02-09T00:00:00.000Z',
    };

    const result = convertPendingRequest(request);
    expect(result.type).toBe('question');
    if (result.type === 'question') {
      expect(result.request.toolName).toBe('AskUserQuestion');
      expect(result.request.acpOptions).toEqual(acpOptions);
    }
  });

  it('maps legacy tool-input titles with questions to question prompts', () => {
    const request: PendingInteractiveRequest = {
      requestId: 'req-2',
      toolName: 'Tool input request',
      toolUseId: 'tool-2',
      input: {
        questions: [{ question: 'Pick one', options: [{ label: 'A', description: 'a' }] }],
      },
      planContent: null,
      timestamp: '2026-02-09T00:00:00.000Z',
    };

    const result = convertPendingRequest(request);
    expect(result.type).toBe('question');
  });

  it('keeps non-question tools as permission requests', () => {
    const acpOptions = [{ optionId: 'default', name: 'Default', kind: 'allow_once' as const }];
    const request: PendingInteractiveRequest = {
      requestId: 'req-3',
      toolName: 'ReadFile',
      toolUseId: 'tool-3',
      input: { path: 'README.md' },
      planContent: null,
      acpOptions,
      timestamp: '2026-02-09T00:00:00.000Z',
    };

    const result = convertPendingRequest(request);
    expect(result.type).toBe('permission');
    if (result.type === 'permission') {
      expect(result.request.acpOptions).toEqual(acpOptions);
    }
  });
});
