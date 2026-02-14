import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { getClaudeProjectPath } from '@/backend/lib/claude-paths';
import { createLogger } from '@/backend/services/logger.service';
import type { ClaudeContentItem, ClaudeMessagePayload, HistoryMessage } from '@/shared/claude';
import type { ClaudeJson } from '../claude/types';

export type { HistoryMessage } from '@/shared/claude';

const logger = createLogger('session-file-reader');

const SessionJsonlEntrySchema = z
  .object({
    type: z.string(),
    timestamp: z.string().optional(),
    uuid: z.string().optional(),
    isMeta: z.boolean().optional(),
    gitBranch: z.string().optional(),
    message: z.unknown().optional(),
  })
  .passthrough();

export interface SessionInfo {
  claudeSessionId: string;
  createdAt: Date;
  modifiedAt: Date;
  sizeBytes: number;
}

export class SessionFileReader {
  static getProjectPath(workingDir: string): string {
    return getClaudeProjectPath(workingDir);
  }

  static getSessionPath(claudeSessionId: string, workingDir: string): string {
    return join(SessionFileReader.getProjectPath(workingDir), `${claudeSessionId}.jsonl`);
  }

  static getSessionPathFromProjectPath(claudeSessionId: string, projectPath: string): string {
    return join(projectPath, `${claudeSessionId}.jsonl`);
  }

  static hasSessionFileFromProjectPath(claudeSessionId: string, projectPath: string): boolean {
    const sessionPath = SessionFileReader.getSessionPathFromProjectPath(
      claudeSessionId,
      projectPath
    );
    return existsSync(sessionPath);
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
          logger.warn('Skipping malformed JSONL line', {
            claudeSessionId,
            line: line.slice(0, 100),
            error,
          });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('Error reading session', { claudeSessionId, sessionPath, error });
      }
    }

    return messages;
  }

  static getHistory(claudeSessionId: string, workingDir: string): Promise<HistoryMessage[]> {
    const sessionPath = SessionFileReader.getSessionPath(claudeSessionId, workingDir);
    return SessionFileReader.parseHistoryFromPath(claudeSessionId, sessionPath);
  }

  static getHistoryFromProjectPath(
    claudeSessionId: string,
    projectPath: string
  ): Promise<HistoryMessage[]> {
    const sessionPath = SessionFileReader.getSessionPathFromProjectPath(
      claudeSessionId,
      projectPath
    );
    return SessionFileReader.parseHistoryFromPath(claudeSessionId, sessionPath);
  }

  static async getSessionModel(
    claudeSessionId: string,
    workingDir: string
  ): Promise<string | null> {
    const sessionPath = SessionFileReader.getSessionPath(claudeSessionId, workingDir);

    try {
      const content = await readFile(sessionPath, 'utf-8');
      const lines = content.split('\n').filter((line) => line.trim());

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

  static async getSessionGitBranch(
    claudeSessionId: string,
    workingDir: string
  ): Promise<string | null> {
    const sessionPath = SessionFileReader.getSessionPath(claudeSessionId, workingDir);

    try {
      const content = await readFile(sessionPath, 'utf-8');
      const lines = content.split('\n').filter((line) => line.trim());

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

  static async listSessions(workingDir: string): Promise<SessionInfo[]> {
    const projectPath = SessionFileReader.getProjectPath(workingDir);
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
          logger.warn('Could not stat session file', { filePath });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('Error listing sessions', { workingDir, error });
      }
    }

    return sessions;
  }

  static extractClaudeSessionId(msg: ClaudeJson): string | undefined {
    if (msg.type === 'system') {
      return undefined;
    }

    if (msg.type === 'stream_event') {
      return undefined;
    }

    if (msg.type === 'assistant' || msg.type === 'user') {
      return msg.session_id;
    }

    if (msg.type === 'result') {
      return msg.session_id ?? msg.sessionId;
    }

    return undefined;
  }
}

/** Backward-compatible alias for incremental migration */
export { SessionFileReader as SessionManager };

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
  const normalizedContent = normalizeUserContent(content);
  const hasToolResult = normalizedContent.some((item) => item.type === 'tool_result');
  const hasNonToolResult = normalizedContent.some((item) => item.type !== 'tool_result');

  if (hasToolResult && hasNonToolResult) {
    return [{ type: 'user_tool_result', content: normalizedContent, ...meta }];
  }

  if (hasToolResult) {
    return parseToolResultOnlyContent(normalizedContent, meta);
  }

  return parseUserTextAndAttachmentContent(content, meta);
}

function parseUserEntry(message: ClaudeMessagePayload, meta: EntryMetadata): HistoryMessage[] {
  const { content } = message;

  if (typeof content === 'string') {
    return parseUserStringContent(content, meta);
  }

  if (Array.isArray(content)) {
    return parseUserArrayContent(content as ClaudeContentItem[], meta);
  }

  return [];
}

function parseAssistantEntry(message: ClaudeMessagePayload, meta: EntryMetadata): HistoryMessage[] {
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

function isSystemContent(text: string): boolean {
  return text.startsWith('<system_instruction>') || text.startsWith('<local-command');
}

export function parseHistoryEntry(entry: Record<string, unknown>): HistoryMessage[] {
  if (entry.isMeta === true) {
    return [];
  }

  const type = entry.type as string;
  const meta: EntryMetadata = {
    timestamp: (entry.timestamp as string) || new Date().toISOString(),
    uuid: entry.uuid as string | undefined,
  };

  const message = entry.message as ClaudeMessagePayload | undefined;
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
