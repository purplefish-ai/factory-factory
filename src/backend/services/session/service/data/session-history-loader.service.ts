import { access, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { configService } from '@/backend/services/config.service';
import { createLogger } from '@/backend/services/logger.service';
import { summarizeZodIssues } from '@/backend/services/session/service/zod-issue-summary';
import type { HistoryMessage, ToolResultContentValue } from '@/shared/acp-protocol';
import { buildHistoryImageAttachments, HistoryImageSourceSchema } from './history-image-attachment';
import {
  type HistoryFileReuse,
  type HistoryLoadResult,
  loadHistoryFile,
  type ReusedHistoryFile,
} from './session-history-file';
import { readNonEmptyJsonlLines } from './session-history-jsonl-reader';

const logger = createLogger('session-history-loader');

const ToolResultChunkType = z.enum([
  'tool_result',
  'tool_search_tool_result',
  'web_fetch_tool_result',
  'web_search_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'mcp_tool_result',
]);

const ClaudeHistoryMessageSchema = z
  .object({
    role: z.string().optional(),
    content: z.unknown().optional(),
    id: z.string().optional(),
    timestamp: z.string().optional(),
  })
  .passthrough();

const ClaudeHistoryEntrySchema = z
  .object({
    type: z.string().optional(),
    isSidechain: z.boolean().optional(),
    isMeta: z.boolean().optional(),
    turnCompanion: z.boolean().optional(),
    isCompactSummary: z.boolean().optional(),
    isVisibleInTranscriptOnly: z.boolean().optional(),
    origin: z.unknown().optional(),
    sessionId: z.string().optional(),
    timestamp: z.string().optional(),
    createdAt: z.string().optional(),
    uuid: z.string().optional(),
    message: ClaudeHistoryMessageSchema.optional(),
  })
  .passthrough();

type ClaudeSessionHistoryEntry = z.infer<typeof ClaudeHistoryEntrySchema>;
const SAFE_PROVIDER_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export type ClaudeSessionHistoryLoadResult = HistoryLoadResult;

function getClaudeConfigDir(): string {
  return configService.getClaudeConfigDir();
}

function encodeProjectPath(cwd: string): string {
  const windowsPathMatch = cwd.match(/^([A-Za-z]):[\\/]/);
  if (windowsPathMatch) {
    const driveLetter = windowsPathMatch[1];
    const rest = cwd.slice(2);
    return `${driveLetter}${rest.replace(/[\\/]/g, '-')}`;
  }

  return cwd.replace(/\//g, '-');
}

function sessionFilePath(cwd: string, providerSessionId: string): string {
  return join(
    getClaudeConfigDir(),
    'projects',
    encodeProjectPath(cwd),
    `${providerSessionId}.jsonl`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withOptionalUuid<T extends HistoryMessage>(message: T, uuid: string | undefined): T {
  if (!uuid) {
    return message;
  }
  return { ...message, uuid };
}

function safeJsonStringify(value: unknown): string {
  if (value === undefined) {
    return '';
  }

  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function normalizeTimestamp(
  entry: ClaudeSessionHistoryEntry,
  lineNumber: number,
  fallbackBaseTimestampMs: number
): string {
  const rawCandidates = [entry.timestamp, entry.createdAt, entry.message?.timestamp];
  for (const candidate of rawCandidates) {
    if (typeof candidate === 'string' && !Number.isNaN(Date.parse(candidate))) {
      return candidate;
    }
  }

  return new Date(fallbackBaseTimestampMs + lineNumber).toISOString();
}

function normalizeToolResultContent(value: unknown): ToolResultContentValue {
  if (typeof value === 'string') {
    return value;
  }

  if (!Array.isArray(value)) {
    return safeJsonStringify(value);
  }

  const items: Array<{ type: 'text'; text: string } | { type: 'image'; source: unknown }> = [];

  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }

    if (item.type === 'text' && typeof item.text === 'string') {
      items.push({ type: 'text', text: item.text });
      continue;
    }

    if (item.type === 'image' && isRecord(item.source)) {
      items.push({ type: 'image', source: item.source });
    }
  }

  return items.length > 0 ? (items as ToolResultContentValue) : safeJsonStringify(value);
}

function parseTextChunkAsHistory(
  role: 'assistant' | 'user',
  chunk: Record<string, unknown>,
  timestamp: string,
  uuid: string | undefined
): HistoryMessage | null {
  if (chunk.type !== 'text' && chunk.type !== 'text_delta') {
    return null;
  }
  if (typeof chunk.text !== 'string') {
    return null;
  }

  return withOptionalUuid(
    {
      type: role === 'assistant' ? 'assistant' : 'user',
      content: chunk.text,
      timestamp,
    },
    uuid
  );
}

function parseThinkingChunkAsHistory(
  role: 'assistant' | 'user',
  chunk: Record<string, unknown>,
  timestamp: string,
  uuid: string | undefined
): HistoryMessage | null {
  if (role !== 'assistant') {
    return null;
  }
  if (chunk.type !== 'thinking' && chunk.type !== 'thinking_delta') {
    return null;
  }
  if (typeof chunk.thinking !== 'string') {
    return null;
  }

  return withOptionalUuid(
    {
      type: 'thinking',
      content: chunk.thinking,
      timestamp,
    },
    uuid
  );
}

function parseToolUseChunkAsHistory(
  role: 'assistant' | 'user',
  chunk: Record<string, unknown>,
  timestamp: string,
  uuid: string | undefined
): HistoryMessage | null {
  if (role !== 'assistant') {
    return null;
  }

  if (
    chunk.type !== 'tool_use' &&
    chunk.type !== 'server_tool_use' &&
    chunk.type !== 'mcp_tool_use'
  ) {
    return null;
  }

  const toolName = typeof chunk.name === 'string' ? chunk.name : undefined;
  const toolId = typeof chunk.id === 'string' ? chunk.id : undefined;
  const toolInput = isRecord(chunk.input) ? chunk.input : undefined;

  return withOptionalUuid(
    {
      type: 'tool_use',
      content: toolName ?? 'Tool call',
      ...(toolName ? { toolName } : {}),
      ...(toolId ? { toolId } : {}),
      ...(toolInput ? { toolInput } : {}),
      timestamp,
    },
    uuid
  );
}

function parseToolResultChunkAsHistory(
  role: 'assistant' | 'user',
  chunk: Record<string, unknown>,
  timestamp: string,
  uuid: string | undefined
): HistoryMessage | null {
  if (role !== 'user') {
    return null;
  }
  if (typeof chunk.type !== 'string' || !ToolResultChunkType.safeParse(chunk.type).success) {
    return null;
  }

  const toolId = typeof chunk.tool_use_id === 'string' ? chunk.tool_use_id : undefined;
  const isError = typeof chunk.is_error === 'boolean' ? chunk.is_error : undefined;

  return withOptionalUuid(
    {
      type: 'tool_result',
      content: normalizeToolResultContent(chunk.content),
      ...(toolId ? { toolId } : {}),
      ...(typeof isError === 'boolean' ? { isError } : {}),
      timestamp,
    },
    uuid
  );
}

function parseChunkAsHistory(
  role: 'assistant' | 'user',
  chunk: unknown,
  timestamp: string,
  uuid: string | undefined
): HistoryMessage | null {
  if (!isRecord(chunk)) {
    return null;
  }

  return (
    parseTextChunkAsHistory(role, chunk, timestamp, uuid) ??
    parseThinkingChunkAsHistory(role, chunk, timestamp, uuid) ??
    parseToolUseChunkAsHistory(role, chunk, timestamp, uuid) ??
    parseToolResultChunkAsHistory(role, chunk, timestamp, uuid)
  );
}

const HistoryImageSchema = z.object({
  type: z.literal('image'),
  source: HistoryImageSourceSchema.extend({ type: z.literal('base64') }),
});

function restoreUserImages(
  messages: HistoryMessage[],
  content: unknown[],
  timestamp: string,
  uuid: string | undefined
): void {
  const images = content.flatMap((chunk, index) => {
    const parsed = HistoryImageSchema.safeParse(chunk);
    return parsed.success ? [{ source: parsed.data.source, index }] : [];
  });
  const attachments = buildHistoryImageAttachments(images, `history-image-${uuid ?? timestamp}`);
  if (attachments.length === 0) {
    return;
  }
  // Keep attachments on the original prompt instead of creating separate chat rows.
  const userMessage = messages.find((message) => message.type === 'user');
  if (userMessage) {
    userMessage.attachments = attachments;
  } else {
    messages.unshift(withOptionalUuid({ type: 'user', content: '', timestamp, attachments }, uuid));
  }
}

function parseContentAsHistory(
  role: 'assistant' | 'user',
  content: string | unknown[],
  timestamp: string,
  uuid: string | undefined
): HistoryMessage[] {
  if (typeof content === 'string') {
    return [
      withOptionalUuid(
        {
          type: role === 'assistant' ? 'assistant' : 'user',
          content,
          timestamp,
        },
        uuid
      ),
    ];
  }

  const messages: HistoryMessage[] = [];
  for (const chunk of content) {
    const parsed = parseChunkAsHistory(role, chunk, timestamp, uuid);
    if (parsed) {
      messages.push(parsed);
    }
  }

  if (role === 'user') {
    restoreUserImages(messages, content, timestamp, uuid);
  }
  return messages;
}

function parseHistoryEntry(params: {
  line: string;
  filePath: string;
  lineNumber: number;
}): ClaudeSessionHistoryEntry | null {
  let parsedLine: unknown;
  try {
    parsedLine = JSON.parse(params.line);
  } catch (error) {
    logger.warn('Skipping malformed Claude history JSON line', {
      filePath: params.filePath,
      lineNumber: params.lineNumber,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const parsedEntry = ClaudeHistoryEntrySchema.safeParse(parsedLine);
  if (!parsedEntry.success) {
    logger.warn('Skipping Claude history line that failed schema validation', {
      filePath: params.filePath,
      lineNumber: params.lineNumber,
      issues: summarizeZodIssues(parsedEntry.error.issues),
    });
    return null;
  }

  return parsedEntry.data;
}

function resolveSessionRole(entry: ClaudeSessionHistoryEntry): 'assistant' | 'user' | null {
  if (entry.message?.role === 'assistant') {
    return 'assistant';
  }
  if (entry.message?.role === 'user') {
    return 'user';
  }
  return null;
}

function resolveSessionUuid(entry: ClaudeSessionHistoryEntry): string | undefined {
  if (typeof entry.uuid === 'string') {
    return entry.uuid;
  }
  return typeof entry.message?.id === 'string' ? entry.message.id : undefined;
}

function isEntryEligible(entry: ClaudeSessionHistoryEntry, providerSessionId: string): boolean {
  if (entry.type !== 'user' && entry.type !== 'assistant') {
    return false;
  }
  // Background task stops are model context, not user prompts. A subkind marks
  // a delivered prompt (such as a routine), which must remain in the transcript.
  if (
    entry.type === 'user' &&
    isRecord(entry.origin) &&
    entry.origin.kind === 'task-notification' &&
    entry.origin.subkind === undefined
  ) {
    return false;
  }
  // Harness metadata, image companions, and /compact summaries are not conversation messages.
  if (
    entry.isSidechain ||
    entry.isMeta ||
    entry.turnCompanion ||
    entry.isCompactSummary ||
    entry.isVisibleInTranscriptOnly
  ) {
    return false;
  }
  if (entry.sessionId && entry.sessionId !== providerSessionId) {
    return false;
  }
  return true;
}

function isSafeProviderSessionId(providerSessionId: string): boolean {
  return SAFE_PROVIDER_SESSION_ID_PATTERN.test(providerSessionId);
}

async function resolveSessionFilePath(
  workingDir: string,
  providerSessionId: string,
  isCurrent: () => boolean = () => true
): Promise<string | null> {
  if (!isCurrent()) {
    return null;
  }
  const fileName = `${providerSessionId}.jsonl`;
  const expectedPath = sessionFilePath(workingDir, providerSessionId);

  try {
    await access(expectedPath);
    return isCurrent() ? expectedPath : null;
  } catch {
    // Fallback scan across all projects.
  }

  if (!isCurrent()) {
    return null;
  }
  const projectsDir = join(getClaudeConfigDir(), 'projects');
  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return null;
  }

  for (const encodedPath of projectDirs) {
    if (!isCurrent()) {
      return null;
    }
    const candidate = await findSessionFileInProject(
      join(projectsDir, encodedPath),
      fileName,
      isCurrent
    );
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

async function findSessionFileInProject(
  projectDir: string,
  fileName: string,
  isCurrent: () => boolean
): Promise<string | null> {
  try {
    const projectStats = await stat(projectDir);
    if (!(isCurrent() && projectStats.isDirectory())) {
      return null;
    }
    const candidatePath = join(projectDir, fileName);
    await access(candidatePath);
    return isCurrent() ? candidatePath : null;
  } catch {
    // Ignore unreadable directories and projects without this session.
    return null;
  }
}

class ClaudeSessionHistoryLoaderService {
  async loadSessionHistory<T = never>(params: {
    providerSessionId: string | null | undefined;
    workingDir: string;
    /** Parse only transcript lines containing this text, found by a byte search. */
    onlyLinesContaining?: string;
    isCurrent?: () => boolean;
    reuse?: HistoryFileReuse<T>;
  }): Promise<ClaudeSessionHistoryLoadResult | ReusedHistoryFile<T>> {
    if (!params.providerSessionId) {
      return { status: 'skipped', reason: 'missing_provider_session_id' };
    }
    if (!isSafeProviderSessionId(params.providerSessionId)) {
      logger.warn('Skipping Claude history load for unsafe provider session id', {
        providerSessionId: params.providerSessionId,
      });
      return { status: 'skipped', reason: 'invalid_provider_session_id' };
    }

    const filePath = await resolveSessionFilePath(
      params.workingDir,
      params.providerSessionId,
      params.isCurrent
    );
    if (!filePath) {
      return { status: 'not_found' };
    }

    const providerSessionId = params.providerSessionId;
    return await loadHistoryFile({
      filePath,
      reuse: params.reuse,
      read: () =>
        this.readHistoryFromFile(
          filePath,
          providerSessionId,
          params.onlyLinesContaining,
          params.isCurrent
        ),
    });
  }

  private async readHistoryFromFile(
    filePath: string,
    providerSessionId: string,
    containing?: string,
    isCurrent?: () => boolean
  ): Promise<{ history: HistoryMessage[]; hadReadError: boolean }> {
    const history: HistoryMessage[] = [];
    const fallbackBaseTimestampMs = Date.now();
    let hadReadError = false;

    await readNonEmptyJsonlLines({
      filePath,
      containing,
      isCurrent,
      onLine: (trimmed, lineNumber) => {
        const entry = parseHistoryEntry({ line: trimmed, filePath, lineNumber });
        if (!(entry && isEntryEligible(entry, providerSessionId))) {
          return;
        }

        const role = resolveSessionRole(entry);
        if (!role) {
          return;
        }

        const content = entry.message?.content;
        if (typeof content !== 'string' && !Array.isArray(content)) {
          return;
        }

        const timestamp = normalizeTimestamp(entry, lineNumber, fallbackBaseTimestampMs);
        const uuid = resolveSessionUuid(entry);
        history.push(...parseContentAsHistory(role, content, timestamp, uuid));
      },
      onError: (error) => {
        hadReadError = true;
        logger.warn('Failed parsing Claude session history file', {
          filePath,
          providerSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });

    return { history, hadReadError };
  }
}

export const claudeSessionHistoryLoaderService = new ClaudeSessionHistoryLoaderService();
