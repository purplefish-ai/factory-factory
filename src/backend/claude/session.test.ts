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

  describe('extractSessionId', () => {
    it('should extract session_id from assistant messages', () => {
      const msg: ClaudeJson = {
        type: 'assistant',
        session_id: 'abc123',
        message: { role: 'assistant', content: [] },
      };
      expect(SessionManager.extractSessionId(msg)).toBe('abc123');
    });

    it('should extract session_id from user messages', () => {
      const msg: ClaudeJson = {
        type: 'user',
        session_id: 'user-session-456',
        message: { role: 'user', content: 'Hello' },
      };
      expect(SessionManager.extractSessionId(msg)).toBe('user-session-456');
    });

    it('should extract session_id from result messages using session_id field', () => {
      const msg: ClaudeJson = {
        type: 'result',
        session_id: 'result-session-789',
      };
      expect(SessionManager.extractSessionId(msg)).toBe('result-session-789');
    });

    it('should extract sessionId from result messages using sessionId field', () => {
      const msg: ClaudeJson = {
        type: 'result',
        sessionId: 'result-session-camel',
      };
      expect(SessionManager.extractSessionId(msg)).toBe('result-session-camel');
    });

    it('should prefer session_id over sessionId in result messages', () => {
      const msg: ClaudeJson = {
        type: 'result',
        session_id: 'snake-case-wins',
        sessionId: 'camel-case-loses',
      };
      expect(SessionManager.extractSessionId(msg)).toBe('snake-case-wins');
    });

    it('should return undefined for system messages', () => {
      const msg: ClaudeJson = {
        type: 'system',
        session_id: 'should-be-ignored',
      };
      expect(SessionManager.extractSessionId(msg)).toBeUndefined();
    });

    it('should return undefined for stream_event messages', () => {
      const msg: ClaudeJson = {
        type: 'stream_event',
        session_id: 'should-be-ignored',
        event: { type: 'message_start', message: { role: 'assistant', content: [] } },
      };
      expect(SessionManager.extractSessionId(msg)).toBeUndefined();
    });

    it('should return undefined for control_request messages', () => {
      const msg: ClaudeJson = {
        type: 'control_request',
        request_id: 'req-123',
        request: { subtype: 'can_use_tool', tool_name: 'Read', input: {} },
      };
      expect(SessionManager.extractSessionId(msg)).toBeUndefined();
    });

    it('should return undefined for control_response messages', () => {
      const msg: ClaudeJson = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req-123',
          response: { behavior: 'allow' },
        },
      };
      expect(SessionManager.extractSessionId(msg)).toBeUndefined();
    });

    it('should return undefined for control_cancel_request messages', () => {
      const msg: ClaudeJson = {
        type: 'control_cancel_request',
        request_id: 'req-123',
      };
      expect(SessionManager.extractSessionId(msg)).toBeUndefined();
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
      expect(result[0].type).toBe('user');
      expect(result[0].content).toBe('Hello, Claude!');
      expect(result[0].timestamp).toBe(timestamp);
      expect(result[0].uuid).toBe('uuid-123');
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
      expect(result[0].type).toBe('user');
      expect(result[0].content).toBe('Hello from array!');
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
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('First message');
      expect(result[1].content).toBe('Second message');
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
      expect(result[0].type).toBe('tool_result');
      expect(result[0].content).toBe('File contents here');
      expect(result[0].toolId).toBe('tool-123');
      expect(result[0].isError).toBe(false);
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
      expect(result[0].type).toBe('tool_result');
      expect(result[0].isError).toBe(true);
    });

    it('should parse tool_result with array content', () => {
      const entry = {
        type: 'user',
        timestamp,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-789',
              content: [
                { type: 'text', text: 'Line 1' },
                { type: 'text', text: 'Line 2' },
              ],
            },
          ],
        },
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('Line 1\nLine 2');
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
      expect(result[0].content).toBe('');
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
      expect(result[0].type).toBe('assistant');
      expect(result[0].content).toBe('Hello!');
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
      expect(result[0].type).toBe('assistant');
      expect(result[0].content).toBe('Direct string response');
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
      expect(result[0].type).toBe('tool_use');
      expect(result[0].toolName).toBe('Read');
      expect(result[0].toolId).toBe('tool-123');
      expect(result[0].toolInput).toEqual({ file_path: '/test.txt' });
      expect(result[0].content).toBe(JSON.stringify({ file_path: '/test.txt' }, null, 2));
    });

    it('should skip thinking content', () => {
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
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('assistant');
      expect(result[0].content).toBe('Here is my response');
    });

    it('should return empty array when only thinking content exists', () => {
      const entry = {
        type: 'assistant',
        timestamp,
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Just thinking...' }],
        },
      };
      const result = parseHistoryEntry(entry);
      expect(result).toHaveLength(0);
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
      expect(result[0].type).toBe('assistant');
      expect(result[1].type).toBe('tool_use');
      expect(result[2].type).toBe('assistant');
      expect(result[3].type).toBe('tool_use');
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
      expect(new Date(result[0].timestamp).getTime()).toBeGreaterThanOrEqual(
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
      expect(result[0].uuid).toBeUndefined();
    });
  });
});
