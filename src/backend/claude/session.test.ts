import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseHistoryEntry, SessionManager } from './session';
import type { ClaudeJson } from './types';

describe('SessionManager', () => {
  describe('getProjectPath', () => {
    it('should escape forward slashes with hyphens', () => {
      const path = SessionManager.getProjectPath('/Users/test/project');
      expect(path).toContain('-Users-test-project');
    });

    it('should return correct path format under .claude/projects', () => {
      const path = SessionManager.getProjectPath('/home/user/myproject');
      expect(path).toBe(join(homedir(), '.claude', 'projects', '-home-user-myproject'));
    });

    it('should handle paths with multiple slashes', () => {
      const path = SessionManager.getProjectPath('/a/b/c/d/e');
      expect(path).toBe(join(homedir(), '.claude', 'projects', '-a-b-c-d-e'));
    });

    it('should handle empty path', () => {
      const path = SessionManager.getProjectPath('');
      expect(path).toBe(join(homedir(), '.claude', 'projects', ''));
    });
  });

  describe('getSessionPath', () => {
    it('should combine project path with session ID', () => {
      const path = SessionManager.getSessionPath('abc123', '/Users/test/project');
      expect(path).toBe(
        join(homedir(), '.claude', 'projects', '-Users-test-project', 'abc123.jsonl')
      );
    });

    it('should append .jsonl extension to session ID', () => {
      const path = SessionManager.getSessionPath('session-xyz', '/home/user/work');
      expect(path.endsWith('session-xyz.jsonl')).toBe(true);
    });
  });

  describe('extractClaudeSessionId', () => {
    it('should extract session_id from assistant messages', () => {
      const msg: ClaudeJson = {
        type: 'assistant',
        session_id: 'abc123',
        message: { role: 'assistant', content: [] },
      };
      expect(SessionManager.extractClaudeSessionId(msg)).toBe('abc123');
    });

    it('should extract session_id from user messages', () => {
      const msg: ClaudeJson = {
        type: 'user',
        session_id: 'user-session-456',
        message: { role: 'user', content: 'Hello' },
      };
      expect(SessionManager.extractClaudeSessionId(msg)).toBe('user-session-456');
    });

    it('should extract session_id from result messages using session_id field', () => {
      const msg: ClaudeJson = {
        type: 'result',
        session_id: 'result-session-789',
      };
      expect(SessionManager.extractClaudeSessionId(msg)).toBe('result-session-789');
    });

    it('should extract sessionId from result messages using sessionId field', () => {
      const msg: ClaudeJson = {
        type: 'result',
        sessionId: 'result-session-camel',
      };
      expect(SessionManager.extractClaudeSessionId(msg)).toBe('result-session-camel');
    });

    it('should prefer session_id over sessionId in result messages', () => {
      const msg: ClaudeJson = {
        type: 'result',
        session_id: 'snake-case-wins',
        sessionId: 'camel-case-loses',
      };
      expect(SessionManager.extractClaudeSessionId(msg)).toBe('snake-case-wins');
    });

    it('should return undefined for system messages', () => {
      const msg: ClaudeJson = {
        type: 'system',
        session_id: 'should-be-ignored',
      };
      expect(SessionManager.extractClaudeSessionId(msg)).toBeUndefined();
    });

    it('should return undefined for stream_event messages', () => {
      const msg: ClaudeJson = {
        type: 'stream_event',
        session_id: 'should-be-ignored',
        event: { type: 'message_start', message: { role: 'assistant', content: [] } },
      };
      expect(SessionManager.extractClaudeSessionId(msg)).toBeUndefined();
    });

    it('should return undefined for control_request messages', () => {
      const msg: ClaudeJson = {
        type: 'control_request',
        request_id: 'req-123',
        request: { subtype: 'can_use_tool', tool_name: 'Read', input: {} },
      };
      expect(SessionManager.extractClaudeSessionId(msg)).toBeUndefined();
    });

    it('should return undefined for control_response messages', () => {
      const msg: ClaudeJson = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req-123',
          response: { behavior: 'allow', updatedInput: {} },
        },
      };
      expect(SessionManager.extractClaudeSessionId(msg)).toBeUndefined();
    });

    it('should return undefined for control_cancel_request messages', () => {
      const msg: ClaudeJson = {
        type: 'control_cancel_request',
        request_id: 'req-123',
      };
      expect(SessionManager.extractClaudeSessionId(msg)).toBeUndefined();
    });
  });
});

describe('parseHistoryEntry', () => {
  const timestamp = '2025-01-25T10:00:00Z';

  describe('user messages', () => {
    it('should parse user message with string content', () => {
      const entry = {
        type: 'user',
        timestamp,
        uuid: 'uuid-123',
        message: {
          role: 'user',
          content: 'Hello, Claude!',
        },
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(1);
      expect(result[0]!.type).toBe('user');
      expect(result[0]!.content).toBe('Hello, Claude!');
      expect(result[0]!.timestamp).toBe(timestamp);
      expect(result[0]!.uuid).toBe('uuid-123');
    });

    it('should parse user message with text content array', () => {
      const entry = {
        type: 'user',
        timestamp,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Hello from array!' }],
        },
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(1);
      expect(result[0]!.type).toBe('user');
      expect(result[0]!.content).toBe('Hello from array!');
    });

    it('should parse user message with multiple text content items', () => {
      const entry = {
        type: 'user',
        timestamp,
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'First message' },
            { type: 'text', text: 'Second message' },
          ],
        },
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(1);
      expect(result[0]!.content).toBe('First message\n\nSecond message');
    });

    it('should parse user message with tool_result content', () => {
      const entry = {
        type: 'user',
        timestamp,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-123',
              content: 'File contents here',
              is_error: false,
            },
          ],
        },
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(1);
      const first = result[0];
      expect(first?.type).toBe('tool_result');
      expect(first?.content).toBe('File contents here');
      if (first?.type !== 'tool_result') {
        throw new Error('Expected tool_result message');
      }
      expect(first.toolId).toBe('tool-123');
      expect(first.isError).toBe(false);
    });

    it('should preserve user content and tool_result as separate entries', () => {
      const entry = {
        type: 'user',
        timestamp,
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Please inspect this' },
            {
              type: 'tool_result',
              tool_use_id: 'tool-321',
              content: 'Tool output',
            },
          ],
        },
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        type: 'user',
        content: 'Please inspect this',
      });
      expect(result[1]).toMatchObject({
        type: 'tool_result',
        content: 'Tool output',
        toolId: 'tool-321',
      });
    });

    it('should parse user image content into attachment metadata', () => {
      const entry = {
        type: 'user',
        timestamp,
        uuid: 'uuid-image-1',
        message: {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'Zm9vYmFy',
              },
            },
          ],
        },
      };

      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(1);
      expect(result[0]!.type).toBe('user');
      expect(result[0]!.content).toBe('');
      expect(result[0]!.attachments).toHaveLength(1);
      expect(result[0]!.attachments?.[0]).toMatchObject({
        id: 'uuid-image-1-image-0',
        name: 'image-1.png',
        type: 'image/png',
        contentType: 'image',
        data: 'Zm9vYmFy',
      });
      expect(result[0]!.attachments?.[0]?.size).toBe(6);
    });

    it('should parse text and image user content into a single history entry', () => {
      const entry = {
        type: 'user',
        timestamp,
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'See screenshot' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: '/9j/4AAQ',
              },
            },
          ],
        },
      };

      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(1);
      expect(result[0]!.type).toBe('user');
      expect(result[0]!.content).toBe('See screenshot');
      expect(result[0]!.attachments?.[0]).toMatchObject({
        name: 'image-2.jpeg',
        type: 'image/jpeg',
        contentType: 'image',
      });
    });

    it('should parse user message with tool_result error', () => {
      const entry = {
        type: 'user',
        timestamp,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-456',
              content: 'File not found',
              is_error: true,
            },
          ],
        },
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(1);
      const first = result[0];
      expect(first?.type).toBe('tool_result');
      if (first?.type !== 'tool_result') {
        throw new Error('Expected tool_result message');
      }
      expect(first.isError).toBe(true);
    });

    it('should parse tool_result with array content', () => {
      const content = [
        { type: 'text' as const, text: 'Line 1' },
        { type: 'text' as const, text: 'Line 2' },
      ];
      const entry = {
        type: 'user',
        timestamp,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-789',
              content,
            },
          ],
        },
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(1);
      expect(result[0]!.content).toEqual(content);
    });

    it('should handle tool_result with empty array content', () => {
      const entry = {
        type: 'user',
        timestamp,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-empty',
              content: [],
            },
          ],
        },
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(1);
      expect(result[0]!.content).toEqual([]);
    });

    it('should preserve tool_result image content blocks', () => {
      const content = [
        {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: 'image/png', data: 'Zm9vYmFy' },
        },
      ];
      const entry = {
        type: 'user',
        timestamp,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-image',
              content,
            },
          ],
        },
      };

      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(1);
      expect(result[0]!.type).toBe('tool_result');
      expect(result[0]!.content).toEqual(content);
    });
  });

  describe('assistant messages', () => {
    it('should parse assistant message with text content', () => {
      const entry = {
        type: 'assistant',
        timestamp,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello!' }],
        },
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(1);
      expect(result[0]!.type).toBe('assistant');
      expect(result[0]!.content).toBe('Hello!');
    });

    it('should parse assistant message with string content', () => {
      const entry = {
        type: 'assistant',
        timestamp,
        message: {
          role: 'assistant',
          content: 'Direct string response',
        },
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(1);
      expect(result[0]!.type).toBe('assistant');
      expect(result[0]!.content).toBe('Direct string response');
    });

    it('should parse assistant message with tool_use content', () => {
      const entry = {
        type: 'assistant',
        timestamp,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-123',
              name: 'Read',
              input: { file_path: '/test.txt' },
            },
          ],
        },
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(1);
      const first = result[0];
      expect(first?.type).toBe('tool_use');
      if (first?.type !== 'tool_use') {
        throw new Error('Expected tool_use message');
      }
      expect(first.toolName).toBe('Read');
      expect(first.toolId).toBe('tool-123');
      expect(first.toolInput).toEqual({ file_path: '/test.txt' });
      expect(first.content).toBe(JSON.stringify({ file_path: '/test.txt' }, null, 2));
    });

    it('should include thinking content', () => {
      const entry = {
        type: 'assistant',
        timestamp,
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me think...' },
            { type: 'text', text: 'Here is my response' },
          ],
        },
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(2);
      expect(result[0]!.type).toBe('thinking');
      expect(result[0]!.content).toBe('Let me think...');
      expect(result[1]!.type).toBe('assistant');
      expect(result[1]!.content).toBe('Here is my response');
    });

    it('should return thinking content when only thinking content exists', () => {
      const entry = {
        type: 'assistant',
        timestamp,
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Just thinking...' }],
        },
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(1);
      expect(result[0]!.type).toBe('thinking');
      expect(result[0]!.content).toBe('Just thinking...');
    });

    it('should parse multiple content items in assistant message', () => {
      const entry = {
        type: 'assistant',
        timestamp,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me read that file' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/a.txt' } },
            { type: 'text', text: 'Now let me write' },
            { type: 'tool_use', id: 'tool-2', name: 'Write', input: { file_path: '/b.txt' } },
          ],
        },
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(4);
      expect(result[0]!.type).toBe('assistant');
      expect(result[1]!.type).toBe('tool_use');
      expect(result[2]!.type).toBe('assistant');
      expect(result[3]!.type).toBe('tool_use');
    });
  });

  describe('edge cases', () => {
    it('should return empty array for unknown entry types', () => {
      const entry = {
        type: 'unknown',
        timestamp,
        message: {
          role: 'user',
          content: 'Should be ignored',
        },
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(0);
    });

    it('should return empty array for entries without message field', () => {
      const entry = {
        type: 'user',
        timestamp,
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(0);
    });

    it('should return empty array for entries with null message', () => {
      const entry = {
        type: 'user',
        timestamp,
        message: null,
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(0);
    });

    it('should return empty array for entries with undefined message', () => {
      const entry = {
        type: 'user',
        timestamp,
        message: undefined,
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(0);
    });

    it('should use current timestamp if timestamp is missing', () => {
      const beforeTest = new Date().toISOString();
      const entry = {
        type: 'user',
        message: {
          role: 'user',
          content: 'No timestamp',
        },
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(1);
      // Timestamp should be after test started
      expect(new Date(result[0]!.timestamp).getTime()).toBeGreaterThanOrEqual(
        new Date(beforeTest).getTime() - 1000
      );
    });

    it('should handle empty content array', () => {
      const entry = {
        type: 'user',
        timestamp,
        message: {
          role: 'user',
          content: [],
        },
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(0);
    });

    it('should not include uuid if not present', () => {
      const entry = {
        type: 'user',
        timestamp,
        message: {
          role: 'user',
          content: 'No uuid',
        },
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(1);
      expect(result[0]!.uuid).toBeUndefined();
    });
  });

  describe('malformed entries', () => {
    it('should return empty array for entry without type field', () => {
      const entry = {
        timestamp,
        message: {
          role: 'user',
          content: 'Missing type',
        },
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(0);
    });

    it('should return empty array for entry without message field', () => {
      const entry = {
        type: 'user',
        timestamp,
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(0);
    });

    it('should skip meta messages', () => {
      const entry = {
        type: 'user',
        timestamp,
        isMeta: true,
        message: {
          role: 'user',
          content: 'Meta message',
        },
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(0);
    });

    it('should return empty array for unknown message type', () => {
      const entry = {
        type: 'unknown_type',
        timestamp,
        message: {
          role: 'unknown',
          content: 'Unknown',
        },
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(0);
    });
  });
});
