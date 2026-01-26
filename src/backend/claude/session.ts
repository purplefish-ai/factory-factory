import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeContentItem, ClaudeJson, ClaudeMessage } from './types.js';

/**
 * Represents a message from session history
 */
export interface HistoryMessage {
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  content: string;
  timestamp: string;
  uuid?: string;
  // Tool-specific fields
  toolName?: string;
  toolId?: string;
  toolInput?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Information about a session
 */
export interface SessionInfo {
  sessionId: string;
  createdAt: Date;
  modifiedAt: Date;
  sizeBytes: number;
}

/**
 * Session manager for reading session history and listing sessions
 */
export class SessionManager {
  /**
   * Get the path to Claude's project sessions directory for a given working directory.
   * Sessions are stored at: ~/.claude/projects/<escaped-path>/<session-id>.jsonl
   */
  static getProjectPath(workingDir: string): string {
    // Replace / with - for path escaping
    const escapedPath = workingDir.replace(/\//g, '-');
    return join(homedir(), '.claude', 'projects', escapedPath);
  }

  /**
   * Get the path to a specific session file
   */
  static getSessionPath(sessionId: string, workingDir: string): string {
    return join(SessionManager.getProjectPath(workingDir), `${sessionId}.jsonl`);
  }

  /**
   * Get session history from JSONL file
   */
  static async getHistory(sessionId: string, workingDir: string): Promise<HistoryMessage[]> {
    const sessionPath = SessionManager.getSessionPath(sessionId, workingDir);
    const messages: HistoryMessage[] = [];

    try {
      const content = await readFile(sessionPath, 'utf-8');
      const lines = content.split('\n').filter((line) => line.trim());

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          const parsedMessages = parseHistoryEntry(entry);
          messages.push(...parsedMessages);
        } catch {
          // Skip malformed JSONL lines
          console.warn(`Skipping malformed JSONL line in session ${sessionId}`);
        }
      }
    } catch (error) {
      // Return empty array if file doesn't exist or can't be read
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`Error reading session ${sessionId}:`, error);
      }
    }

    return messages;
  }

  /**
   * List available sessions for a working directory
   */
  static async listSessions(workingDir: string): Promise<SessionInfo[]> {
    const projectPath = SessionManager.getProjectPath(workingDir);
    const sessions: SessionInfo[] = [];

    try {
      const files = await readdir(projectPath);

      for (const file of files) {
        if (!file.endsWith('.jsonl')) {
          continue;
        }

        const sessionId = file.replace('.jsonl', '');
        const filePath = join(projectPath, file);

        try {
          const fileStat = await stat(filePath);
          sessions.push({
            sessionId,
            createdAt: fileStat.birthtime,
            modifiedAt: fileStat.mtime,
            sizeBytes: fileStat.size,
          });
        } catch {
          // Skip files we can't stat
          console.warn(`Could not stat session file: ${filePath}`);
        }
      }
    } catch (error) {
      // Return empty array if project directory doesn't exist
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`Error listing sessions for ${workingDir}:`, error);
      }
    }

    return sessions;
  }

  /**
   * Extract session ID from a ClaudeJson message.
   * Returns undefined for system and stream_event messages (per protocol rules).
   */
  static extractSessionId(msg: ClaudeJson): string | undefined {
    // Skip system messages for session ID extraction
    if (msg.type === 'system') {
      return undefined;
    }

    // Skip stream_event messages for session ID extraction
    if (msg.type === 'stream_event') {
      return undefined;
    }

    // Extract from assistant, user, or result messages
    if (msg.type === 'assistant' || msg.type === 'user') {
      return msg.session_id;
    }

    if (msg.type === 'result') {
      // Support both session_id and sessionId field names
      return msg.session_id ?? msg.sessionId;
    }

    // Control messages don't typically have session IDs
    return undefined;
  }
}

/**
 * Entry metadata for parsing
 */
interface EntryMetadata {
  timestamp: string;
  uuid?: string;
}

/**
 * Extract text content from tool result
 */
function extractToolResultContent(item: ClaudeContentItem & { type: 'tool_result' }): string {
  if (typeof item.content === 'string') {
    return item.content;
  }
  if (Array.isArray(item.content)) {
    return item.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  }
  return '';
}

/**
 * Parse a user content item into a HistoryMessage
 */
function parseUserContentItem(item: ClaudeContentItem, meta: EntryMetadata): HistoryMessage | null {
  if (item.type === 'text') {
    // Skip system content in text items
    if (isSystemContent(item.text)) {
      return null;
    }
    return { type: 'user', content: item.text, ...meta };
  }
  if (item.type === 'tool_result') {
    return {
      type: 'tool_result',
      content: extractToolResultContent(item),
      toolId: item.tool_use_id,
      isError: item.is_error,
      ...meta,
    };
  }
  return null;
}

/**
 * Parse an assistant content item into a HistoryMessage
 */
function parseAssistantContentItem(
  item: ClaudeContentItem,
  meta: EntryMetadata
): HistoryMessage | null {
  if (item.type === 'text') {
    return { type: 'assistant', content: item.text, ...meta };
  }
  if (item.type === 'tool_use') {
    return {
      type: 'tool_use',
      content: JSON.stringify(item.input, null, 2),
      toolName: item.name,
      toolId: item.id,
      toolInput: item.input,
      ...meta,
    };
  }
  // Skip thinking items - not shown in UI
  return null;
}

/**
 * Parse user message entry
 */
function parseUserEntry(message: ClaudeMessage, meta: EntryMetadata): HistoryMessage[] {
  const { content } = message;

  if (typeof content === 'string') {
    // Skip system content (instructions, local command output)
    if (isSystemContent(content)) {
      return [];
    }
    return [{ type: 'user', content, ...meta }];
  }

  if (Array.isArray(content)) {
    return (content as ClaudeContentItem[])
      .map((item) => parseUserContentItem(item, meta))
      .filter((m): m is HistoryMessage => m !== null);
  }

  return [];
}

/**
 * Parse assistant message entry
 */
function parseAssistantEntry(message: ClaudeMessage, meta: EntryMetadata): HistoryMessage[] {
  const { content } = message;

  if (typeof content === 'string') {
    return [{ type: 'assistant', content, ...meta }];
  }

  if (Array.isArray(content)) {
    return (content as ClaudeContentItem[])
      .map((item) => parseAssistantContentItem(item, meta))
      .filter((m): m is HistoryMessage => m !== null);
  }

  return [];
}

/**
 * Checks if content is system/meta content that shouldn't be shown in the UI.
 * These include:
 * - System instructions injected by Conductor
 * - Local command output (caveats, stdout, etc.)
 */
function isSystemContent(text: string): boolean {
  return text.startsWith('<system_instruction>') || text.startsWith('<local-command');
}

/**
 * Parse a single JSONL entry into HistoryMessage(s)
 */
export function parseHistoryEntry(entry: Record<string, unknown>): HistoryMessage[] {
  // Skip meta messages (local command caveats, etc.)
  if (entry.isMeta === true) {
    return [];
  }

  const type = entry.type as string;
  const meta: EntryMetadata = {
    timestamp: (entry.timestamp as string) || new Date().toISOString(),
    uuid: entry.uuid as string | undefined,
  };

  const message = entry.message as ClaudeMessage | undefined;
  if (!message) {
    return [];
  }

  if (type === 'user') {
    return parseUserEntry(message, meta);
  }

  if (type === 'assistant') {
    return parseAssistantEntry(message, meta);
  }

  return [];
}
