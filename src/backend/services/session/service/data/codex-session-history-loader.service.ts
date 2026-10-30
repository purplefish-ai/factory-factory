import { createReadStream } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { codexAccountService, type CodexRuntimeContext } from '@/backend/services/codex-accounts';
import { createLogger, getCurrentProcessEnv } from '@/backend/services/logger.service';
import { normalizeCodexSessionId as normalizeProviderSessionId } from '@/backend/services/session/service/acp/acp-session-identity';
import { summarizeZodIssues } from '@/backend/services/session/service/zod-issue-summary';
import type { HistoryMessage, MessageAttachment } from '@/shared/acp-protocol';
import { buildHistoryImageAttachments, parseImageDataUrl } from './history-image-attachment';
import { readNonEmptyJsonlLines } from './session-history-jsonl-reader';

const logger = createLogger('codex-session-history-loader');
const SAFE_PROVIDER_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const UUID_V7_SESSION_ID_PATTERN =
  /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DATE_SESSION_FILE_SEARCH_DEPTH = 3;
const MAX_RECENT_SESSION_DATE_DIRS = 120;
const SESSION_FILE_LOOKUP_CACHE_LIMIT = 1024;
const POSITIVE_SESSION_FILE_LOOKUP_CACHE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_SESSION_FILE_LOOKUP_CACHE_TTL_MS = 30 * 1000;
// Rollouts without content_item_kinds record harness context as plain user text before the
// first prompt; later tag-only messages are kept because the user may have typed them.
const INJECTED_CONTEXT_PATTERN =
  /^\s*(?:<(environment_context|user_instructions)>[\s\S]*?<\/\1>\s*)+$/;
const JsonObjectSchema = z.record(z.string(), z.unknown());

const CodexHistoryEntrySchema = z
  .object({
    timestamp: z.string().optional(),
    type: z.string().optional(),
    payload: z.unknown().optional(),
  })
  .passthrough();

const CodexSessionMetaEntrySchema = z
  .object({
    type: z.literal('session_meta'),
    payload: z
      .object({
        id: z.string().optional(),
        cwd: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const CodexMessageMetadataSchema = z.object({
  turn_id: z.string().optional(),
  content_item_kinds: z.array(z.string()).optional(),
});
const CodexResponseMessageSchema = z.object({
  id: z.string().optional(),
  type: z.literal('message'),
  role: z.enum(['user', 'assistant']),
  content: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
      image_url: z.string().optional(),
    })
  ),
  phase: z.string().nullish(),
  channel: z.string().nullish(),
  internal_chat_message_metadata_passthrough: CodexMessageMetadataSchema.nullish(),
});
const CodexTurnIdentitySchema = z.object({
  turn_id: z.string().optional(),
  internal_chat_message_metadata_passthrough: CodexMessageMetadataSchema.nullish(),
});

type CodexHistoryEntry = z.infer<typeof CodexHistoryEntrySchema>;
type CodexHistorySource = 'event' | 'response';
type CodexHistoryTurn = {
  id?: string;
  messages: { source: CodexHistorySource; message: HistoryMessage }[];
};
type SessionFileLookupCacheEntry = {
  filePath: string | null;
  expiresAtMs: number;
};
type DateSessionDirectoryCandidate = {
  directoryPath: string;
  mtimeMs: number;
  dateKey: string;
};
type SessionFileSelection = {
  cwdMatch: string | null;
  idOnlyMatch: string | null;
};

const sessionFileLookupCache = new Map<string, SessionFileLookupCacheEntry>();

export type CodexSessionHistoryLoadResult =
  | { status: 'loaded'; history: HistoryMessage[]; filePath: string }
  | { status: 'not_found' }
  | { status: 'skipped'; reason: 'missing_provider_session_id' | 'invalid_provider_session_id' }
  | { status: 'error'; reason: 'read_failed'; filePath: string };

function getOptionalEnvPath(name: 'CODEX_HOME' | 'CODEX_SESSIONS_DIR'): string | undefined {
  const value = getCurrentProcessEnv()[name]?.trim();
  if (!value || value === 'undefined' || value === 'null') {
    return undefined;
  }
  return value;
}

function getCodexHomeDir(): string {
  return getOptionalEnvPath('CODEX_HOME') ?? join(homedir(), '.codex');
}

function getCodexSessionsDir(): string {
  return getOptionalEnvPath('CODEX_SESSIONS_DIR') ?? join(getCodexHomeDir(), 'sessions');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeProviderSessionId(providerSessionId: string): boolean {
  return SAFE_PROVIDER_SESSION_ID_PATTERN.test(providerSessionId);
}

function getProviderSessionIdCandidates(providerSessionId: string): string[] {
  const normalized = normalizeProviderSessionId(providerSessionId);
  if (normalized === providerSessionId) {
    return [providerSessionId];
  }
  return [providerSessionId, normalized];
}

function isMatchingProviderSessionId(candidateId: string, providerSessionId: string): boolean {
  return normalizeProviderSessionId(candidateId) === normalizeProviderSessionId(providerSessionId);
}

function buildSessionFileLookupCacheKey(params: {
  sessionsDir: string;
  workingDir: string;
  providerSessionId: string;
}): string {
  return JSON.stringify({
    sessionsDir: params.sessionsDir,
    workingDir: params.workingDir,
    providerSessionId: normalizeProviderSessionId(params.providerSessionId),
  });
}

async function getCachedSessionFilePath(params: {
  cacheKey: string;
  providerSessionId: string;
  workingDir: string;
}): Promise<string | null | undefined> {
  const cached = sessionFileLookupCache.get(params.cacheKey);
  if (!cached) {
    return undefined;
  }

  if (cached.expiresAtMs <= Date.now()) {
    sessionFileLookupCache.delete(params.cacheKey);
    return undefined;
  }

  if (cached.filePath !== null) {
    const stats = await stat(cached.filePath).catch(() => null);
    if (!stats?.isFile()) {
      sessionFileLookupCache.delete(params.cacheKey);
      return undefined;
    }

    const meta = await parseSessionMeta(cached.filePath);
    if (
      typeof meta?.id !== 'string' ||
      !isMatchingProviderSessionId(meta.id, params.providerSessionId) ||
      meta.cwd !== params.workingDir
    ) {
      sessionFileLookupCache.delete(params.cacheKey);
      return undefined;
    }
  }

  sessionFileLookupCache.delete(params.cacheKey);
  sessionFileLookupCache.set(params.cacheKey, cached);
  return cached.filePath;
}

function setCachedSessionFilePath(cacheKey: string, filePath: string | null): void {
  const ttlMs =
    filePath === null
      ? NEGATIVE_SESSION_FILE_LOOKUP_CACHE_TTL_MS
      : POSITIVE_SESSION_FILE_LOOKUP_CACHE_TTL_MS;
  sessionFileLookupCache.set(cacheKey, {
    filePath,
    expiresAtMs: Date.now() + ttlMs,
  });

  while (sessionFileLookupCache.size > SESSION_FILE_LOOKUP_CACHE_LIMIT) {
    const oldestKey = sessionFileLookupCache.keys().next().value;
    if (typeof oldestKey !== 'string') {
      break;
    }
    sessionFileLookupCache.delete(oldestKey);
  }
}

function getUuidV7TimestampMs(providerSessionId: string): number | null {
  const normalizedSessionId = normalizeProviderSessionId(providerSessionId);
  const match = UUID_V7_SESSION_ID_PATTERN.exec(normalizedSessionId);
  if (!match) {
    return null;
  }

  const timestampMs = Number.parseInt(`${match[1]}${match[2]}`, 16);
  if (!Number.isSafeInteger(timestampMs)) {
    return null;
  }

  return timestampMs;
}

function formatUtcDateSessionDir(sessionsDir: string, timestampMs: number): string {
  const date = new Date(timestampMs);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return join(sessionsDir, year, month, day);
}

function getExpectedDateSessionDirs(sessionsDir: string, providerSessionId: string): string[] {
  const timestampMs = getUuidV7TimestampMs(providerSessionId);
  if (timestampMs === null) {
    return [];
  }

  const oneDayMs = 24 * 60 * 60 * 1000;
  return [
    formatUtcDateSessionDir(sessionsDir, timestampMs),
    formatUtcDateSessionDir(sessionsDir, timestampMs - oneDayMs),
    formatUtcDateSessionDir(sessionsDir, timestampMs + oneDayMs),
  ];
}

function isDateDirectoryPart(entryName: string, digits: number): boolean {
  return entryName.length === digits && /^\d+$/.test(entryName);
}

function buildSessionFileSuffixes(providerSessionId: string): string[] {
  return getProviderSessionIdCandidates(providerSessionId).map(
    (sessionIdCandidate) => `${sessionIdCandidate}.jsonl`
  );
}

function isCandidateSessionFile(fileName: string, fileSuffixes: string[]): boolean {
  return fileSuffixes.some((fileSuffix) => fileName.endsWith(fileSuffix));
}

function truncateForLog(value: string, maxLength = 200): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...(truncated)`;
}

function parseHistoryEntry(params: {
  line: string;
  filePath: string;
  lineNumber: number;
}): CodexHistoryEntry | null {
  let parsedLine: unknown;
  try {
    parsedLine = JSON.parse(params.line);
  } catch (error) {
    logger.warn('Skipping malformed Codex history JSON line', {
      filePath: params.filePath,
      lineNumber: params.lineNumber,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const parsed = CodexHistoryEntrySchema.safeParse(parsedLine);
  if (!parsed.success) {
    logger.warn('Skipping Codex history line that failed schema validation', {
      filePath: params.filePath,
      lineNumber: params.lineNumber,
      issues: summarizeZodIssues(parsed.error.issues),
    });
    return null;
  }

  return parsed.data;
}

function normalizeTimestamp(
  entry: CodexHistoryEntry,
  lineNumber: number,
  fallbackBaseTimestampMs: number
): string {
  if (typeof entry.timestamp === 'string' && !Number.isNaN(Date.parse(entry.timestamp))) {
    return entry.timestamp;
  }

  return new Date(fallbackBaseTimestampMs + lineNumber).toISOString();
}

function parseCodexEventMessage(
  entry: CodexHistoryEntry,
  timestamp: string
): HistoryMessage | null {
  if (entry.type !== 'event_msg' || !isRecord(entry.payload)) {
    return null;
  }

  const eventType = entry.payload.type;
  if (eventType === 'user_message') {
    const message = typeof entry.payload.message === 'string' ? entry.payload.message : '';
    const attachments = parseEventImageAttachments(entry.payload.images, timestamp);
    if (message.trim().length === 0 && attachments.length === 0) {
      return null;
    }

    return {
      type: 'user',
      content: message,
      timestamp,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }

  if (eventType === 'agent_message') {
    const message = entry.payload.message;
    if (typeof message !== 'string' || message.trim().length === 0) {
      return null;
    }

    return {
      type: 'assistant',
      content: message,
      timestamp,
    };
  }

  return null;
}

/** Legacy `user_message` events carry pasted images as data URLs; local file paths are not read. */
function parseEventImageAttachments(images: unknown, timestamp: string): MessageAttachment[] {
  if (!Array.isArray(images)) {
    return [];
  }
  const sources = images.flatMap((image, index) => {
    const source = parseImageDataUrl(image);
    return source ? [{ source, index }] : [];
  });
  return buildHistoryImageAttachments(sources, `codex-history-image-${timestamp}`);
}

function normalizeCodexFunctionArgs(argumentsValue: unknown): Record<string, unknown> {
  if (isRecord(argumentsValue)) {
    return argumentsValue;
  }

  if (typeof argumentsValue !== 'string') {
    return {};
  }

  try {
    const parsed = JSON.parse(argumentsValue);
    const validated = JsonObjectSchema.safeParse(parsed);
    if (validated.success) {
      return validated.data;
    }

    logger.warn('Codex function call arguments parsed but failed object validation', {
      issues: summarizeZodIssues(validated.error.issues),
      argumentsPreview: truncateForLog(argumentsValue),
    });
    return { rawArguments: argumentsValue };
  } catch (error) {
    logger.warn('Codex function call arguments are not valid JSON', {
      error: error instanceof Error ? error.message : String(error),
      argumentsPreview: truncateForLog(argumentsValue),
    });
    return { rawArguments: argumentsValue };
  }
}

function normalizeCodexFunctionOutput(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  if (output === undefined || output === null) {
    return '';
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function parseFunctionCallResponseItem(
  payload: Record<string, unknown>,
  timestamp: string
): HistoryMessage[] {
  const toolName = payload.name;
  const toolId = payload.call_id;
  if (
    typeof toolName !== 'string' ||
    toolName.trim().length === 0 ||
    typeof toolId !== 'string' ||
    toolId.trim().length === 0
  ) {
    return [];
  }

  return [
    {
      type: 'tool_use',
      content: '',
      timestamp,
      toolName,
      toolId,
      toolInput: normalizeCodexFunctionArgs(payload.arguments ?? payload.input),
    },
  ];
}

function parseFunctionCallOutputResponseItem(
  payload: Record<string, unknown>,
  timestamp: string
): HistoryMessage[] {
  const toolId = payload.call_id;
  if (typeof toolId !== 'string' || toolId.trim().length === 0) {
    return [];
  }

  return [
    {
      type: 'tool_result',
      content: normalizeCodexFunctionOutput(payload.output),
      timestamp,
      toolId,
    },
  ];
}

function parseCodexResponseItemMessages(
  entry: CodexHistoryEntry,
  timestamp: string
): HistoryMessage[] {
  if (entry.type !== 'response_item' || !isRecord(entry.payload)) {
    return [];
  }

  const payloadType = entry.payload.type;
  if (payloadType === 'message') {
    return parseResponseTextMessage(entry.payload, timestamp);
  }
  if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
    return parseFunctionCallResponseItem(entry.payload, timestamp);
  }

  if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
    return parseFunctionCallOutputResponseItem(entry.payload, timestamp);
  }

  return [];
}

function parseResponseTextMessage(payload: unknown, timestamp: string): HistoryMessage[] {
  const parsed = CodexResponseMessageSchema.safeParse(payload);
  if (!parsed.success) {
    return [];
  }
  const {
    role,
    content,
    phase,
    channel,
    internal_chat_message_metadata_passthrough: metadata,
  } = parsed.data;
  if (
    role === 'assistant' &&
    ((phase != null && phase !== 'commentary' && phase !== 'final_answer') ||
      channel === 'analysis')
  ) {
    return [];
  }
  const kinds = metadata?.content_item_kinds;
  const text = content
    .filter((block, index) =>
      role === 'assistant'
        ? block.type === 'output_text'
        : block.type === 'input_text' && (!kinds || kinds[index] === 'user.text')
    )
    .map((block) => block.text ?? '')
    .join('\n');
  const attachments =
    role === 'user'
      ? buildHistoryImageAttachments(
          content.flatMap((block, index) => {
            const isUserImage =
              block.type === 'input_image' && (!kinds || kinds[index] === 'user.image');
            const source = isUserImage ? parseImageDataUrl(block.image_url) : null;
            return source ? [{ source, index }] : [];
          }),
          `codex-history-image-${parsed.data.id ?? timestamp}`
        )
      : [];
  if (!text.trim() && attachments.length === 0) {
    return [];
  }
  return [
    {
      type: role,
      content: text,
      timestamp,
      ...(attachments.length > 0 ? { attachments } : {}),
    },
  ];
}

function appendHistoryTurn(history: HistoryMessage[], turn: CodexHistoryTurn): void {
  const eventTypes = new Set(
    turn.messages.filter((item) => item.source === 'event').map((item) => item.message.type)
  );
  // Legacy event copies of the prompt may omit images that the response item kept.
  const responseUserAttachments = turn.messages.find(
    (item) => item.source === 'response' && item.message.type === 'user' && item.message.attachments
  )?.message.attachments;
  for (const { source, message } of turn.messages) {
    if (source === 'event' || !eventTypes.has(message.type)) {
      const needsAttachments =
        source === 'event' && message.type === 'user' && !message.attachments;
      history.push(
        needsAttachments && responseUserAttachments
          ? { ...message, attachments: responseUserAttachments }
          : message
      );
    }
  }
  turn.messages = [];
  turn.id = undefined;
}

function startsImplicitTurn(
  turn: CodexHistoryTurn,
  messages: HistoryMessage[],
  source: CodexHistorySource,
  incomingTurnId?: string
): boolean {
  const user = messages.find((message) => message.type === 'user');
  return Boolean(
    user &&
    turn.messages.some(
      (item) =>
        item.message.type === 'assistant' ||
        // An identified prompt starts a new turn after anonymous legacy history,
        // even if an interrupted turn used the same text and has no assistant reply.
        (Boolean(incomingTurnId) && item.message.type === 'user') ||
        (item.message.type === 'user' &&
          (item.source === source || item.message.content !== user.content))
    )
  );
}

function parseJsonLineWithLogging(params: {
  line: string;
  filePath: string;
  lineNumber: number;
}): unknown | null {
  try {
    return JSON.parse(params.line);
  } catch (error) {
    logger.warn('Failed to parse Codex session_meta candidate line', {
      filePath: params.filePath,
      lineNumber: params.lineNumber,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function parseSessionMetaLine(params: {
  line: string;
  filePath: string;
  lineNumber: number;
}): { id?: string; cwd?: string } | null {
  const parsedLine = parseJsonLineWithLogging(params);
  if (!parsedLine) {
    return null;
  }

  const parsedMeta = CodexSessionMetaEntrySchema.safeParse(parsedLine);
  if (!parsedMeta.success) {
    if (isRecord(parsedLine) && parsedLine.type === 'session_meta') {
      logger.warn('Codex session_meta line failed schema validation', {
        filePath: params.filePath,
        lineNumber: params.lineNumber,
        issues: summarizeZodIssues(parsedMeta.error.issues),
      });
    }
    return null;
  }

  return {
    id: parsedMeta.data.payload.id,
    cwd: parsedMeta.data.payload.cwd,
  };
}

async function parseSessionMeta(filePath: string): Promise<{ id?: string; cwd?: string } | null> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  try {
    let lineNumber = 0;
    for await (const line of reader) {
      lineNumber += 1;
      if (lineNumber > 25) {
        break;
      }

      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const parsedMeta = parseSessionMetaLine({ line: trimmed, filePath, lineNumber });
      if (parsedMeta) {
        return parsedMeta;
      }
    }
  } catch {
    return null;
  } finally {
    reader.close();
    stream.destroy();
  }

  return null;
}

async function collectCandidateSessionFilesInDateDir(
  directoryPath: string,
  fileSuffixes: string[],
  depth = 0
): Promise<string[]> {
  if (depth > MAX_DATE_SESSION_FILE_SEARCH_DEPTH) {
    return [];
  }

  const entries = await readdir(directoryPath, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    return [];
  }

  const candidatePaths: string[] = [];
  for (const entry of entries) {
    const fullPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectCandidateSessionFilesInDateDir(fullPath, fileSuffixes, depth + 1);
      candidatePaths.push(...nested);
      continue;
    }

    if (entry.isFile() && isCandidateSessionFile(entry.name, fileSuffixes)) {
      candidatePaths.push(fullPath);
    }
  }

  return candidatePaths;
}

async function collectCandidateSessionFilesFromDirs(
  directoryPaths: string[],
  fileSuffixes: string[]
): Promise<string[]> {
  const candidateSet = new Set<string>();
  const visitedDirectoryPaths = new Set<string>();

  for (const directoryPath of directoryPaths) {
    if (visitedDirectoryPaths.has(directoryPath)) {
      continue;
    }
    visitedDirectoryPaths.add(directoryPath);

    const discovered = await collectCandidateSessionFilesInDateDir(directoryPath, fileSuffixes);
    for (const candidatePath of discovered) {
      candidateSet.add(candidatePath);
    }
  }

  return [...candidateSet];
}

async function listSubdirectories(directoryPath: string): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
}

async function collectRecentDateSessionDirs(
  sessionsDir: string
): Promise<DateSessionDirectoryCandidate[]> {
  const candidates: DateSessionDirectoryCandidate[] = [];
  const years = (await listSubdirectories(sessionsDir)).filter((year) =>
    isDateDirectoryPart(year, 4)
  );

  yearLoop: for (const year of years) {
    const yearDir = join(sessionsDir, year);
    const months = (await listSubdirectories(yearDir)).filter((month) =>
      isDateDirectoryPart(month, 2)
    );

    for (const month of months) {
      const monthDir = join(yearDir, month);
      const days = (await listSubdirectories(monthDir)).filter((day) =>
        isDateDirectoryPart(day, 2)
      );

      for (const day of days) {
        const directoryPath = join(monthDir, day);
        const stats = await stat(directoryPath).catch(() => null);
        candidates.push({
          directoryPath,
          mtimeMs: stats?.mtimeMs ?? Number.NEGATIVE_INFINITY,
          dateKey: `${year}-${month}-${day}`,
        });

        if (candidates.length >= MAX_RECENT_SESSION_DATE_DIRS) {
          break yearLoop;
        }
      }
    }
  }

  candidates.sort(
    (left, right) => right.mtimeMs - left.mtimeMs || right.dateKey.localeCompare(left.dateKey)
  );
  return candidates;
}

async function selectMatchingSessionFilePath(params: {
  candidates: string[];
  providerSessionId: string;
  workingDir: string;
}): Promise<SessionFileSelection> {
  if (params.candidates.length === 0) {
    return { cwdMatch: null, idOnlyMatch: null };
  }

  const withMtime = await Promise.all(
    params.candidates.map(async (candidatePath) => {
      try {
        const stats = await stat(candidatePath);
        return { candidatePath, mtimeMs: stats.mtimeMs };
      } catch {
        return { candidatePath, mtimeMs: Number.NEGATIVE_INFINITY };
      }
    })
  );
  withMtime.sort((left, right) => right.mtimeMs - left.mtimeMs);

  const metaByPath = new Map<string, { id?: string; cwd?: string } | null>();
  for (const candidate of withMtime) {
    const meta = await parseSessionMeta(candidate.candidatePath);
    metaByPath.set(candidate.candidatePath, meta);
    if (
      typeof meta?.id === 'string' &&
      isMatchingProviderSessionId(meta.id, params.providerSessionId) &&
      meta.cwd === params.workingDir
    ) {
      return { cwdMatch: candidate.candidatePath, idOnlyMatch: null };
    }
  }

  for (const candidate of withMtime) {
    const meta = metaByPath.get(candidate.candidatePath) ?? null;
    if (
      typeof meta?.id === 'string' &&
      isMatchingProviderSessionId(meta.id, params.providerSessionId)
    ) {
      return { cwdMatch: null, idOnlyMatch: candidate.candidatePath };
    }
  }

  return { cwdMatch: null, idOnlyMatch: null };
}

async function resolveUncachedSessionFilePath(
  sessionsDir: string,
  workingDir: string,
  providerSessionId: string
): Promise<string | null> {
  const fileSuffixes = buildSessionFileSuffixes(providerSessionId);
  const expectedDateDirs = getExpectedDateSessionDirs(sessionsDir, providerSessionId);
  const expectedCandidates = await collectCandidateSessionFilesFromDirs(
    expectedDateDirs,
    fileSuffixes
  );
  const expectedSelection = await selectMatchingSessionFilePath({
    candidates: expectedCandidates,
    providerSessionId,
    workingDir,
  });
  if (expectedSelection.cwdMatch) {
    return expectedSelection.cwdMatch;
  }

  const recentDateDirs = await collectRecentDateSessionDirs(sessionsDir);
  const recentCandidates = await collectCandidateSessionFilesFromDirs(
    recentDateDirs.map((candidate) => candidate.directoryPath),
    fileSuffixes
  );
  const recentSelection = await selectMatchingSessionFilePath({
    candidates: recentCandidates,
    providerSessionId,
    workingDir,
  });
  return recentSelection.cwdMatch ?? expectedSelection.idOnlyMatch ?? recentSelection.idOnlyMatch;
}

async function resolveSessionFilePath(
  workingDir: string,
  providerSessionId: string,
  sessionsDir: string
): Promise<string | null> {
  try {
    await access(sessionsDir);
  } catch {
    return null;
  }

  const cacheKey = buildSessionFileLookupCacheKey({ sessionsDir, workingDir, providerSessionId });
  const cachedFilePath = await getCachedSessionFilePath({
    cacheKey,
    providerSessionId,
    workingDir,
  });
  if (cachedFilePath !== undefined) {
    return cachedFilePath;
  }

  const filePath = await resolveUncachedSessionFilePath(sessionsDir, workingDir, providerSessionId);
  setCachedSessionFilePath(cacheKey, filePath);
  return filePath;
}

class CodexSessionHistoryLoaderService {
  async loadSessionHistory(params: {
    providerSessionId: string | null | undefined;
    workingDir: string;
    codexAccountId?: string | null;
    codexAccountContext?: CodexRuntimeContext;
    /**
     * Parse only rollout lines containing this text, found by a byte search.
     * Turn grouping then sees only those lines.
     */
    onlyLinesContaining?: string;
  }): Promise<CodexSessionHistoryLoadResult> {
    const providerSessionId = params.providerSessionId;
    if (!providerSessionId) {
      return { status: 'skipped', reason: 'missing_provider_session_id' };
    }

    if (!isSafeProviderSessionId(providerSessionId)) {
      logger.warn('Skipping Codex history load for unsafe provider session id', {
        providerSessionId,
      });
      return { status: 'skipped', reason: 'invalid_provider_session_id' };
    }

    const context =
      params.codexAccountContext ??
      (params.codexAccountId
        ? await codexAccountService.getHistoryContext(params.codexAccountId)
        : undefined);
    const filePath = await resolveSessionFilePath(
      params.workingDir,
      providerSessionId,
      context?.sessionsDir ?? getCodexSessionsDir()
    );
    if (filePath === null) {
      return { status: 'not_found' };
    }

    const { history, hadReadError } = await this.readHistoryFromFile(
      filePath,
      params.onlyLinesContaining
    );
    if (hadReadError) {
      return { status: 'error', reason: 'read_failed', filePath };
    }

    return { status: 'loaded', history, filePath };
  }

  private async readHistoryFromFile(
    filePath: string,
    containing?: string
  ): Promise<{ history: HistoryMessage[]; hadReadError: boolean }> {
    let hadReadError = false;
    const history: HistoryMessage[] = [];
    const turn: CodexHistoryTurn = { messages: [] };
    const fallbackBaseTimestampMs = Date.now();

    await readNonEmptyJsonlLines({
      filePath,
      containing,
      onLine: (trimmed, lineNumber) =>
        this.appendHistoryFromLine(
          history,
          turn,
          filePath,
          trimmed,
          lineNumber,
          fallbackBaseTimestampMs
        ),
      onError: (error) => {
        hadReadError = true;
        logger.warn('Failed parsing Codex session history file', {
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });

    appendHistoryTurn(history, turn);

    return { history, hadReadError };
  }

  private appendHistoryFromLine(
    history: HistoryMessage[],
    turn: CodexHistoryTurn,
    filePath: string,
    line: string,
    lineNumber: number,
    fallbackBaseTimestampMs: number
  ): void {
    const entry = parseHistoryEntry({ line, filePath, lineNumber });
    if (!entry) {
      return;
    }

    const timestamp = normalizeTimestamp(entry, lineNumber, fallbackBaseTimestampMs);
    const identity = CodexTurnIdentitySchema.safeParse(entry.payload);
    const metadata = identity.data?.internal_chat_message_metadata_passthrough;
    const turnId = identity.data?.turn_id ?? metadata?.turn_id;
    const taskStarted =
      entry.type === 'event_msg' &&
      isRecord(entry.payload) &&
      entry.payload.type === 'task_started';
    if ((turnId && turn.id && turnId !== turn.id) || (taskStarted && turn.messages.length > 0)) {
      appendHistoryTurn(history, turn);
    }
    const legacyStart =
      entry.type === 'response_item' &&
      !metadata?.content_item_kinds &&
      history.length === 0 &&
      turn.messages.length === 0;
    const parsedMessages = parseCodexHistoryMessages(entry, timestamp).filter(
      ({ type, content }) =>
        type !== 'user' || !legacyStart || !INJECTED_CONTEXT_PATTERN.test(content)
    );
    const source = entry.type === 'event_msg' ? 'event' : 'response';
    if (!turn.id && startsImplicitTurn(turn, parsedMessages, source, turnId)) {
      appendHistoryTurn(history, turn);
    }
    if (turnId) {
      turn.id = turnId;
    }
    for (const message of parsedMessages) {
      turn.messages.push({ source, message });
    }
  }
}

function parseCodexHistoryMessages(entry: CodexHistoryEntry, timestamp: string): HistoryMessage[] {
  const eventMessage = parseCodexEventMessage(entry, timestamp);
  if (eventMessage) {
    return [eventMessage];
  }

  return parseCodexResponseItemMessages(entry, timestamp);
}

export const codexSessionHistoryLoaderService = new CodexSessionHistoryLoaderService();
