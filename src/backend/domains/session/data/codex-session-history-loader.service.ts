import { createReadStream } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { createLogger } from '@/backend/services/logger.service';
import type { HistoryMessage } from '@/shared/acp-protocol';

const logger = createLogger('codex-session-history-loader');
const SAFE_PROVIDER_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_SESSION_FILE_SEARCH_DEPTH = 5;

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

function parseHistoryEntry(line: string): CodexHistoryEntry | null {
  let parsedLine: unknown;
  try {
    parsedLine = JSON.parse(line);
  } catch {
    return null;
  }

  const parsed = CodexHistoryEntrySchema.safeParse(parsedLine);
  return parsed.success ? parsed.data : null;
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

function parseCodexHistoryMessage(
  entry: CodexHistoryEntry,
  timestamp: string
): HistoryMessage | null {
  if (entry.type !== 'event_msg') {
    return null;
  }

  if (!isRecord(entry.payload)) {
    return null;
  }

  const eventType = entry.payload.type;
  const message = entry.payload.message;
  if (typeof message !== 'string' || message.trim().length === 0) {
    return null;
  }

  if (eventType === 'user_message') {
    return {
      type: 'user',
      content: message,
      timestamp,
    };
  }

  if (eventType === 'agent_message') {
    return {
      type: 'assistant',
      content: message,
      timestamp,
    };
  }

  return null;
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

      let parsedLine: unknown;
      try {
        parsedLine = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const parsedMeta = CodexSessionMetaEntrySchema.safeParse(parsedLine);
      if (!parsedMeta.success) {
        continue;
      }

      return {
        id: parsedMeta.data.payload.id,
        cwd: parsedMeta.data.payload.cwd,
      };
    }
  } catch {
    return null;
  } finally {
    reader.close();
    stream.destroy();
  }

  return null;
}

async function collectCandidateSessionFiles(
  directoryPath: string,
  fileSuffix: string,
  depth = 0
): Promise<string[]> {
  if (depth > MAX_SESSION_FILE_SEARCH_DEPTH) {
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
      const nested = await collectCandidateSessionFiles(fullPath, fileSuffix, depth + 1);
      candidatePaths.push(...nested);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(fileSuffix)) {
      candidatePaths.push(fullPath);
    }
  }

  return candidatePaths;
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

  const candidates = await collectCandidateSessionFiles(sessionsDir, `${providerSessionId}.jsonl`);
  if (candidates.length === 0) {
    return null;
  }

  const withMtime = await Promise.all(
    candidates.map(async (candidatePath) => {
      try {
        const stats = await stat(candidatePath);
        return { candidatePath, mtimeMs: stats.mtimeMs };
      } catch {
        return { candidatePath, mtimeMs: Number.NEGATIVE_INFINITY };
      }
    })
  );
  withMtime.sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const candidate of withMtime) {
    const meta = await parseSessionMeta(candidate.candidatePath);
    if (meta?.id === providerSessionId && meta.cwd === workingDir) {
      return candidate.candidatePath;
    }
  }

  for (const candidate of withMtime) {
    const meta = await parseSessionMeta(candidate.candidatePath);
    if (meta?.id === providerSessionId) {
      return candidate.candidatePath;
    }
  }

  return withMtime[0]?.candidatePath ?? null;
}

class CodexSessionHistoryLoaderService {
  async loadSessionHistory(params: {
    providerSessionId: string | null | undefined;
    workingDir: string;
  }): Promise<CodexSessionHistoryLoadResult> {
    if (!params.providerSessionId) {
      return { status: 'skipped', reason: 'missing_provider_session_id' };
    }

    if (!isSafeProviderSessionId(params.providerSessionId)) {
      logger.warn('Skipping Codex history load for unsafe provider session id', {
        providerSessionId: params.providerSessionId,
      });
      return { status: 'skipped', reason: 'invalid_provider_session_id' };
    }

    const filePath = await resolveSessionFilePath(params.workingDir, params.providerSessionId);
    if (!filePath) {
      return { status: 'not_found' };
    }

    const readResult = await this.readHistoryFromFile(filePath);
    if (readResult.hadReadError) {
      return { status: 'error', reason: 'read_failed', filePath };
    }

    return { status: 'loaded', history: readResult.history, filePath };
  }

  private async readHistoryFromFile(
    filePath: string
  ): Promise<{ history: HistoryMessage[]; hadReadError: boolean }> {
    const history: HistoryMessage[] = [];
    const fallbackBaseTimestampMs = Date.now();
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    let hadReadError = false;

    try {
      let lineNumber = 0;
      for await (const line of reader) {
        lineNumber += 1;
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        const entry = parseHistoryEntry(trimmed);
        if (!entry) {
          continue;
        }

        const timestamp = normalizeTimestamp(entry, lineNumber, fallbackBaseTimestampMs);
        const parsedMessage = parseCodexHistoryMessage(entry, timestamp);
        if (parsedMessage) {
          history.push(parsedMessage);
        }
      }
    } catch (error) {
      hadReadError = true;
      logger.warn('Failed parsing Codex session history file', {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      reader.close();
      stream.destroy();
    }

    return { history, hadReadError };
  }
}

export const codexSessionHistoryLoaderService = new CodexSessionHistoryLoaderService();
