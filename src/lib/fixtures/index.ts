/**
 * Storybook fixture data extracted from a real Claude CLI session.
 *
 * This module exports session data for use in Storybook stories and tests.
 * The data is a curated selection of ~40-50 messages representing various
 * message types:
 *
 * - System messages (stop_hook_summary, compact_boundary)
 * - User messages (text and tool_result)
 * - Assistant messages (text, thinking, tool_use)
 * - Tool uses: Read, Write, Edit, Bash, Glob, Grep, Task, TodoWrite, etc.
 * - Tool results (success and error)
 *
 * Long content has been truncated to keep the fixture size manageable.
 */

import sessionData from './current-session.json';

export { sessionData };

/**
 * Type representing the session fixture data array.
 */
export type SessionFixture = typeof sessionData;

/**
 * Type representing a single message from the session fixture.
 */
export type SessionMessage = SessionFixture[number];

/**
 * Helper to filter messages by type for Storybook stories.
 */
export function filterMessagesByType<T extends SessionMessage['type']>(
  type: T
): Extract<SessionMessage, { type: T }>[] {
  return sessionData.filter(
    (msg): msg is Extract<SessionMessage, { type: T }> => msg.type === type
  );
}

/**
 * Helper to get messages containing a specific tool use.
 */
export function getToolUseMessages(toolName: string): SessionMessage[] {
  return sessionData.filter((msg) => {
    if (msg.type !== 'assistant' || !msg.message?.content) {
      return false;
    }
    const content = msg.message.content;
    if (!Array.isArray(content)) {
      return false;
    }
    return content.some(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        'type' in item &&
        item.type === 'tool_use' &&
        'name' in item &&
        item.name === toolName
    );
  });
}

/**
 * Helper to get messages containing tool results (success or error).
 */
export function getToolResultMessages(isError?: boolean): SessionMessage[] {
  return sessionData.filter((msg) => {
    if (msg.type !== 'user' || !msg.message?.content) {
      return false;
    }
    const content = msg.message.content;
    if (!Array.isArray(content)) {
      return false;
    }
    return content.some((item) => {
      if (typeof item !== 'object' || item === null || !('type' in item)) {
        return false;
      }
      if (item.type !== 'tool_result') {
        return false;
      }
      if (isError === undefined) {
        return true;
      }
      return ('is_error' in item && item.is_error) === isError;
    });
  });
}
