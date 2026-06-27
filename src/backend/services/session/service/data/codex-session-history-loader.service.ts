import { createReadStream } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { createLogger } from '@/backend/services/logger.service';
import { summarizeZodIssues } from '@/backend/services/session/service/zod-issue-summary';
import type { HistoryMessage } from '@/shared/acp-protocol';
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

type CodexHistoryEntry = z.infer<typeof CodexHistoryEntrySchema>;
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
  const value = process.env[name];
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

function normalizeProviderSessionId(providerSessionId: string): string {
  return providerSessionId.startsWith('sess_')
    ? providerSessionId.slice('sess_'.length)
    : providerSessionId;
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

async function getCachedSessionFilePath(cacheKey: string): Promise<string | null | undefined> {
  const cached = sessionFileLookupCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }

  if (cached.expiresAtMs <= Date.now()) {
    sessionFileLookupCache.delete(cacheKey);
    return undefined;
  }

  if (cached.filePath !== null) {
    const stats = await stat(cached.filePath).catch(() => null);
    if (!stats?.isFile()) {
      sessionFileLookupCache.delete(cacheKey);
      return undefined;
    }
  }

  sessionFileLookupCache.delete(cacheKey);
  sessionFileLookupCache.set(cacheKey, cached);
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
    const message = entry.payload.message;
    if (typeof message !== 'string' || message.trim().length === 0) {
      return null;
    }

    return {
      type: 'user',
      content: message,
      timestamp,
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
  if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
    return parseFunctionCallResponseItem(entry.payload, timestamp);
  }

  if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
    return parseFunctionCallOutputResponseItem(entry.payload, timestamp);
  }

  return [];
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
  providerSessionId: string
): Promise<string | null> {
  const sessionsDir = getCodexSessionsDir();
  try {
    await access(sessionsDir);
  } catch {
    return null;
  }

  const cacheKey = buildSessionFileLookupCacheKey({ sessionsDir, workingDir, providerSessionId });
  const cachedFilePath = await getCachedSessionFilePath(cacheKey);
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

    const filePath = await resolveSessionFilePath(params.workingDir, providerSessionId);
    if (filePath === null) {
      return { status: 'not_found' };
    }

    const { history, hadReadError } = await this.readHistoryFromFile(filePath);
    if (hadReadError) {
      return { status: 'error', reason: 'read_failed', filePath };
    }

    return { status: 'loaded', history, filePath };
  }

  private async readHistoryFromFile(
    filePath: string
  ): Promise<{ history: HistoryMessage[]; hadReadError: boolean }> {
    let hadReadError = false;
    const history: HistoryMessage[] = [];
    const fallbackBaseTimestampMs = Date.now();

    await readNonEmptyJsonlLines({
      filePath,
      onLine: (trimmed, lineNumber) =>
        this.appendHistoryFromLine(history, filePath, trimmed, lineNumber, fallbackBaseTimestampMs),
      onError: (error) => {
        hadReadError = true;
        logger.warn('Failed parsing Codex session history file', {
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });

    return { history, hadReadError };
  }

  private appendHistoryFromLine(
    history: HistoryMessage[],
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
    const parsedMessages = parseCodexHistoryMessages(entry, timestamp);
    if (parsedMessages.length > 0) {
      history.push(...parsedMessages);
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
