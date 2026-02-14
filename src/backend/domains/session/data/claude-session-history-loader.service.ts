import { createReadStream } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { createLogger } from '@/backend/services/logger.service';
import type { HistoryMessage, ToolResultContentValue } from '@/shared/acp-protocol';

const logger = createLogger('claude-session-history-loader');

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
    sessionId: z.string().optional(),
    timestamp: z.string().optional(),
    createdAt: z.string().optional(),
    uuid: z.string().optional(),
    message: ClaudeHistoryMessageSchema.optional(),
  })
  .passthrough();

type ClaudeSessionHistoryEntry = z.infer<typeof ClaudeHistoryEntrySchema>;

export type ClaudeSessionHistoryLoadResult =
  | { status: 'loaded'; history: HistoryMessage[]; filePath: string }
  | { status: 'not_found' }
  | { status: 'skipped'; reason: 'missing_provider_session_id' };

function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
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
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeTimestamp(entry: ClaudeSessionHistoryEntry, lineNumber: number): string {
  const rawCandidates = [entry.timestamp, entry.createdAt, entry.message?.timestamp];
  for (const candidate of rawCandidates) {
    if (typeof candidate === 'string' && !Number.isNaN(Date.parse(candidate))) {
      return candidate;
    }
  }

  return new Date(lineNumber).toISOString();
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

  return messages;
}

function parseHistoryEntry(line: string): ClaudeSessionHistoryEntry | null {
  let parsedLine: unknown;
  try {
    parsedLine = JSON.parse(line);
  } catch {
    return null;
  }

  const parsedEntry = ClaudeHistoryEntrySchema.safeParse(parsedLine);
  return parsedEntry.success ? parsedEntry.data : null;
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
  if (entry.isSidechain) {
    return false;
  }
  if (entry.sessionId && entry.sessionId !== providerSessionId) {
    return false;
  }
  return true;
}

async function resolveSessionFilePath(
  workingDir: string,
  providerSessionId: string
): Promise<string | null> {
  const fileName = `${providerSessionId}.jsonl`;
  const expectedPath = sessionFilePath(workingDir, providerSessionId);

  try {
    await access(expectedPath);
    return expectedPath;
  } catch {
    // Fallback scan across all projects.
  }

  const projectsDir = join(getClaudeConfigDir(), 'projects');
  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return null;
  }

  for (const encodedPath of projectDirs) {
    const projectDir = join(projectsDir, encodedPath);
    try {
      const projectStats = await stat(projectDir);
      if (!projectStats.isDirectory()) {
        continue;
      }
      const candidatePath = join(projectDir, fileName);
      try {
        await access(candidatePath);
        return candidatePath;
      } catch {
        // Session file not in this project directory.
      }
    } catch {
      // Ignore unreadable project directories while scanning.
    }
  }

  return null;
}

class ClaudeSessionHistoryLoaderService {
  async loadSessionHistory(params: {
    providerSessionId: string | null | undefined;
    workingDir: string;
  }): Promise<ClaudeSessionHistoryLoadResult> {
    if (!params.providerSessionId) {
      return { status: 'skipped', reason: 'missing_provider_session_id' };
    }

    const filePath = await resolveSessionFilePath(params.workingDir, params.providerSessionId);
    if (!filePath) {
      return { status: 'not_found' };
    }

    const history = await this.readHistoryFromFile(filePath, params.providerSessionId);
    return { status: 'loaded', history, filePath };
  }

  private async readHistoryFromFile(
    filePath: string,
    providerSessionId: string
  ): Promise<HistoryMessage[]> {
    const history: HistoryMessage[] = [];
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

    try {
      let lineNumber = 0;
      for await (const line of reader) {
        lineNumber += 1;
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        const entry = parseHistoryEntry(trimmed);
        if (!(entry && isEntryEligible(entry, providerSessionId))) {
          continue;
        }

        const role = resolveSessionRole(entry);
        if (!role) {
          continue;
        }

        const content = entry.message?.content;
        if (typeof content !== 'string' && !Array.isArray(content)) {
          continue;
        }

        const timestamp = normalizeTimestamp(entry, lineNumber);
        const uuid = resolveSessionUuid(entry);
        history.push(...parseContentAsHistory(role, content, timestamp, uuid));
      }
    } catch (error) {
      logger.warn('Failed parsing Claude session history file', {
        filePath,
        providerSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      reader.close();
    }

    return history;
  }
}

export const claudeSessionHistoryLoaderService = new ClaudeSessionHistoryLoaderService();
