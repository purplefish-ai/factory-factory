import { describe, expect, it } from 'vitest';
import {
  isWebSearchToolName,
  parseWebSearchToolInput,
  parseWebSearchToolResult,
} from './web-search-parser';

describe('web-search-parser', () => {
  describe('isWebSearchToolName', () => {
    it('matches webSearch names with optional query suffix', () => {
      expect(isWebSearchToolName('webSearch')).toBe(true);
      expect(isWebSearchToolName('webSearch:OpenAI')).toBe(true);
      expect(isWebSearchToolName('Web_Search')).toBe(true);
      expect(isWebSearchToolName('search')).toBe(false);
    });
  });

  describe('parseWebSearchToolInput', () => {
    it('normalizes web search payloads with unresolved action types', () => {
      const parsed = parseWebSearchToolInput({
        type: 'webSearch',
        id: 'ws_1',
        query: 'OpenAI Codex app-server command/exec method',
        action: {
          type: 'other',
        },
      });

      expect(parsed).toEqual({
        type: 'webSearch',
        id: 'ws_1',
        query: 'OpenAI Codex app-server command/exec method',
        action: {
          type: 'search',
          query: 'OpenAI Codex app-server command/exec method',
          queries: ['OpenAI Codex app-server command/exec method'],
        },
      });
    });
  });

  describe('parseWebSearchToolResult', () => {
    it('extracts nested web search payloads from text result content', () => {
      const parsed = parseWebSearchToolResult(
        JSON.stringify({
          data: {
            latest: {
              type: 'webSearch',
              id: 'ws_2',
              query: 'OpenAI Codex app-server command/exec method',
              action: {
                type: 'search',
                query: 'OpenAI Codex app-server command/exec method',
                queries: ['OpenAI Codex app-server command/exec method'],
              },
            },
          },
        })
      );

      expect(parsed).toEqual({
        type: 'webSearch',
        id: 'ws_2',
        query: 'OpenAI Codex app-server command/exec method',
        action: {
          type: 'search',
          query: 'OpenAI Codex app-server command/exec method',
          queries: ['OpenAI Codex app-server command/exec method'],
        },
        rawText: expect.any(String),
      });
    });
  });
});
