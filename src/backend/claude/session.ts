import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { HistoryMessage } from '@/shared/claude';
import { createLogger } from '../services/logger.service';
import type { ClaudeContentItem, ClaudeJson, ClaudeMessage } from './types';

export type { HistoryMessage } from '@/shared/claude';

const logger = createLogger('session');

/**
 * Zod schema for session JSONL entry validation.
 * Validates minimal required fields: type, and allows optional fields consumed by the code.
 */
const SessionJsonlEntrySchema = z
  .object({
    type: z.string(),
    timestamp: z.string().optional(),
    uuid: z.string().optional(),
    isMeta: z.boolean().optional(),
    gitBranch: z.string().optional(),
    message: z.any().optional(),
  })
  .passthrough();

/**
 * Information about a Claude CLI session (from ~/.claude/projects/).
 * claudeSessionId is the filename (without .jsonl) used by Claude CLI to store history.
 */
export interface SessionInfo {
  claudeSessionId: string;
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
  static getSessionPath(claudeSessionId: string, workingDir: string): string {
    return join(SessionManager.getProjectPath(workingDir), `${claudeSessionId}.jsonl`);
  }

  /**
   * Get the path to a specific session file using a persisted Claude project path.
   */
  static getSessionPathFromProjectPath(claudeSessionId: string, projectPath: string): string {
    return join(projectPath, `${claudeSessionId}.jsonl`);
  }

  private static async parseHistoryFromPath(
    claudeSessionId: string,
    sessionPath: string
  ): Promise<HistoryMessage[]> {
    const messages: HistoryMessage[] = [];

    try {
      const content = await readFile(sessionPath, 'utf-8');
      const lines = content.split('\n').filter((line) => line.trim());

      for (const line of lines) {
        try {
          const rawData = JSON.parse(line);
          const validationResult = SessionJsonlEntrySchema.safeParse(rawData);

          if (!validationResult.success) {
            logger.warn('Skipping invalid JSONL entry', {
              claudeSessionId,
              line: line.slice(0, 100),
              errors: validationResult.error.format(),
            });
            continue;
          }

          const parsedMessages = parseHistoryEntry(validationResult.data);
          messages.push(...parsedMessages);
        } catch (error) {
          // Skip malformed JSONL lines
          logger.warn('Skipping malformed JSONL line', {
            claudeSessionId,
            line: line.slice(0, 100),
            error,
          });
        }
      }
    } catch (error) {
      // Return empty array if file doesn't exist or can't be read
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('Error reading session', { claudeSessionId, sessionPath, error });
      }
    }

    return messages;
  }

  /**
   * Get session history from JSONL file
   */
  static getHistory(claudeSessionId: string, workingDir: string): Promise<HistoryMessage[]> {
    const sessionPath = SessionManager.getSessionPath(claudeSessionId, workingDir);
    return SessionManager.parseHistoryFromPath(claudeSessionId, sessionPath);
  }

  /**
   * Get session history using a persisted Claude project path.
   */
  static getHistoryFromProjectPath(
    claudeSessionId: string,
    projectPath: string
  ): Promise<HistoryMessage[]> {
    const sessionPath = SessionManager.getSessionPathFromProjectPath(claudeSessionId, projectPath);
    return SessionManager.parseHistoryFromPath(claudeSessionId, sessionPath);
  }

  /**
   * Infer the model used in a session by reading the first assistant message.
   * Returns the model ID (e.g., 'claude-opus-4-5-20251101', 'opus') or null if not found.
   */
  static async getSessionModel(
    claudeSessionId: string,
    workingDir: string
  ): Promise<string | null> {
    const sessionPath = SessionManager.getSessionPath(claudeSessionId, workingDir);

    try {
      const content = await readFile(sessionPath, 'utf-8');
      const lines = content.split('\n').filter((line) => line.trim());

      // Look for the first assistant message with a model field
      for (const line of lines) {
        try {
          const rawData = JSON.parse(line);
          const validationResult = SessionJsonlEntrySchema.safeParse(rawData);

          if (!validationResult.success) {
            continue;
          }

          const entry = validationResult.data;
          if (entry.type === 'assistant') {
            const message = entry.message as { model?: string } | undefined;
            if (message?.model) {
              return message.model;
            }
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('Error reading session for model', { claudeSessionId, error });
      }
    }

    return null;
  }

  /**
   * Get the git branch associated with a session.
   * Reads the session file and extracts gitBranch from the first message that has it.
   */
  static async getSessionGitBranch(
    claudeSessionId: string,
    workingDir: string
  ): Promise<string | null> {
    const sessionPath = SessionManager.getSessionPath(claudeSessionId, workingDir);

    try {
      const content = await readFile(sessionPath, 'utf-8');
      const lines = content.split('\n').filter((line) => line.trim());

      // Check first few messages for gitBranch (it should be on most messages)
      for (const line of lines.slice(0, 10)) {
        try {
          const rawData = JSON.parse(line);
          const validationResult = SessionJsonlEntrySchema.safeParse(rawData);

          if (!validationResult.success) {
            continue;
          }

          const entry = validationResult.data;
          if (typeof entry.gitBranch === 'string' && entry.gitBranch) {
            return entry.gitBranch;
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('Error reading session for git branch', { claudeSessionId, error });
      }
    }

    return null;
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

        const claudeSessionId = file.replace('.jsonl', '');
        const filePath = join(projectPath, file);

        try {
          const fileStat = await stat(filePath);
          sessions.push({
            claudeSessionId,
            createdAt: fileStat.birthtime,
            modifiedAt: fileStat.mtime,
            sizeBytes: fileStat.size,
          });
        } catch {
          // Skip files we can't stat
          logger.warn('Could not stat session file', { filePath });
        }
      }
    } catch (error) {
      // Return empty array if project directory doesn't exist
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('Error listing sessions', { workingDir, error });
      }
    }

    return sessions;
  }

  /**
   * Extract Claude CLI session ID from a ClaudeJson message.
   * Returns undefined for system and stream_event messages (per protocol rules).
   */
  static extractClaudeSessionId(msg: ClaudeJson): string | undefined {
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

interface ParsedUserContentAccumulator {
  textParts: string[];
  attachments: NonNullable<HistoryMessage['attachments']>;
}

function inferImageExtension(mediaType: string): string {
  const subtype = mediaType.split('/')[1];
  if (!subtype) {
    return 'bin';
  }
  return subtype.split('+')[0] || 'bin';
}

function estimateBase64Bytes(base64: string): number {
  const normalized = base64.replace(/\s/g, '');
  const paddingMatch = normalized.match(/=+$/);
  const padding = paddingMatch ? paddingMatch[0].length : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function createImageAttachment(
  item: Extract<ClaudeContentItem, { type: 'image' }>,
  meta: EntryMetadata,
  itemIndex: number
): NonNullable<HistoryMessage['attachments']>[number] {
  const mediaType = item.source.media_type || 'application/octet-stream';
  const extension = inferImageExtension(mediaType);
  const attachmentId = meta.uuid
    ? `${meta.uuid}-image-${itemIndex}`
    : `${meta.timestamp}-image-${itemIndex}`;

  return {
    id: attachmentId,
    name: `image-${itemIndex + 1}.${extension}`,
    type: mediaType,
    size: estimateBase64Bytes(item.source.data),
    data: item.source.data,
    contentType: 'image',
  };
}

function parseUserContentItem(
  item: ClaudeContentItem,
  meta: EntryMetadata,
  itemIndex: number,
  acc: ParsedUserContentAccumulator
): void {
  if (item.type === 'text') {
    if (!isSystemContent(item.text)) {
      acc.textParts.push(item.text);
    }
    return;
  }

  if (item.type === 'image') {
    acc.attachments.push(createImageAttachment(item, meta, itemIndex));
    return;
  }

  if (item.type === 'tool_result') {
    // Handled by parseUserEntry.
    return;
  }
}

function flushUserAccumulator(
  result: HistoryMessage[],
  acc: ParsedUserContentAccumulator,
  meta: EntryMetadata
): void {
  if (acc.textParts.length === 0 && acc.attachments.length === 0) {
    return;
  }
  result.push({
    type: 'user',
    content: acc.textParts.join('\n\n'),
    ...(acc.attachments.length > 0 ? { attachments: [...acc.attachments] } : {}),
    ...meta,
  });
  acc.textParts.length = 0;
  acc.attachments.length = 0;
}

function normalizeUserContent(content: ClaudeContentItem[]): ClaudeContentItem[] {
  const normalized: ClaudeContentItem[] = [];
  for (const item of content) {
    if (item.type === 'text') {
      if (!isSystemContent(item.text)) {
        normalized.push(item);
      }
      continue;
    }
    if (item.type === 'image' || item.type === 'tool_result') {
      normalized.push(item);
    }
  }
  return normalized;
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
  if (item.type === 'thinking') {
    return { type: 'thinking', content: item.thinking, ...meta };
  }
  return null;
}

function parseUserStringContent(content: string, meta: EntryMetadata): HistoryMessage[] {
  if (isSystemContent(content)) {
    return [];
  }
  return [{ type: 'user', content, ...meta }];
}

function parseToolResultOnlyContent(
  content: ClaudeContentItem[],
  meta: EntryMetadata
): HistoryMessage[] {
  const result: HistoryMessage[] = [];
  for (const item of content) {
    if (item.type !== 'tool_result') {
      continue;
    }
    result.push({
      type: 'tool_result',
      content: item.content,
      toolId: item.tool_use_id,
      isError: item.is_error,
      ...meta,
    });
  }
  return result;
}

function parseUserTextAndAttachmentContent(
  content: ClaudeContentItem[],
  meta: EntryMetadata
): HistoryMessage[] {
  const result: HistoryMessage[] = [];
  const acc: ParsedUserContentAccumulator = {
    textParts: [],
    attachments: [],
  };

  for (const [index, item] of content.entries()) {
    parseUserContentItem(item, meta, index, acc);
  }

  flushUserAccumulator(result, acc, meta);
  return result;
}

function parseUserArrayContent(
  content: ClaudeContentItem[],
  meta: EntryMetadata
): HistoryMessage[] {
  const hasToolResult = content.some((item) => item.type === 'tool_result');
  const hasNonToolResult = content.some((item) => item.type !== 'tool_result');

  if (hasToolResult && hasNonToolResult) {
    const normalizedContent = normalizeUserContent(content);
    if (normalizedContent.length === 0) {
      return [];
    }
    return [{ type: 'user_tool_result', content: normalizedContent, ...meta }];
  }

  if (hasToolResult) {
    return parseToolResultOnlyContent(content, meta);
  }

  return parseUserTextAndAttachmentContent(content, meta);
}

/**
 * Parse user message entry
 */
function parseUserEntry(message: ClaudeMessage, meta: EntryMetadata): HistoryMessage[] {
  const { content } = message;

  if (typeof content === 'string') {
    return parseUserStringContent(content, meta);
  }

  if (Array.isArray(content)) {
    return parseUserArrayContent(content as ClaudeContentItem[], meta);
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
