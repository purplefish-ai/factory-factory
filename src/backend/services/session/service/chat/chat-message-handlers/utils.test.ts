import { describe, expect, it } from 'vitest';
import type { QueueMessageInput, StartMessageInput } from '@/shared/websocket';
import { buildQueuedMessage, getValidModel, getValidReasoningEffort } from './utils';

describe('chat message handler utils', () => {
  describe('getValidModel', () => {
    it('prefers selectedModel over model', () => {
      const message: StartMessageInput = {
        type: 'start',
        selectedModel: '  gpt-5.3-codex  ',
        model: 'gpt-5',
      };

      expect(getValidModel(message)).toBe('gpt-5.3-codex');
    });

    it('falls back to model when selectedModel is empty', () => {
      const message: StartMessageInput = {
        type: 'start',
        selectedModel: '   ',
        model: '  gpt-5  ',
      };

      expect(getValidModel(message)).toBe('gpt-5');
    });
  });

  describe('getValidReasoningEffort', () => {
    it('trims reasoning effort and returns undefined for blank values', () => {
      expect(
        getValidReasoningEffort({
          type: 'start',
          reasoningEffort: '  medium  ',
        })
      ).toBe('medium');

      expect(
        getValidReasoningEffort({
          type: 'start',
          reasoningEffort: '   ',
        })
      ).toBeUndefined();
    });
  });

  describe('buildQueuedMessage', () => {
    it('normalizes model and reasoning values while preserving other settings', () => {
      const message: QueueMessageInput = {
        type: 'queue_message',
        id: 'msg-1',
        text: 'hello',
        attachments: [
          {
            id: 'att-1',
            name: 'note.txt',
            type: 'text/plain',
            size: 10,
            data: 'hello',
          },
        ],
        settings: {
          selectedModel: '  gpt-5.3-codex  ',
          reasoningEffort: '  high  ',
          thinkingEnabled: true,
          planModeEnabled: false,
        },
      };

      const queued = buildQueuedMessage('queue-1', message, 'hello');

      expect(queued.id).toBe('queue-1');
      expect(queued.settings).toEqual({
        selectedModel: 'gpt-5.3-codex',
        reasoningEffort: 'high',
        thinkingEnabled: true,
        planModeEnabled: false,
      });
      expect(queued.attachments).toEqual(message.attachments);
      expect(Number.isNaN(Date.parse(queued.timestamp))).toBe(false);
    });

    it('fills default settings when message settings are absent', () => {
      const message: QueueMessageInput = {
        type: 'queue_message',
        id: 'msg-1',
        text: 'hello',
      };

      const queued = buildQueuedMessage('queue-1', message, 'hello');

      expect(queued.settings).toEqual({
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      });
    });
  });
});
