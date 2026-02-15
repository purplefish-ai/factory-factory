import { open } from 'node:fs/promises';
import { z } from 'zod';

export interface ParsedLogEntry {
  level: string;
  timestamp: string;
  message: string;
  component: string;
  context: Record<string, unknown>;
}

export interface LogFilter {
  level?: string;
  search?: string;
  sinceMs?: number | null;
  untilMs?: number | null;
}

interface LogPagination {
  limit: number;
  offset: number;
}

export interface LogPageResult {
  entries: ParsedLogEntry[];
  total: number;
  totalIsExact: boolean;
  hasMore: boolean;
}

const RawLogEntrySchema = z.object({
  level: z.string(),
  timestamp: z.string().optional(),
  message: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

type RawLogEntry = z.infer<typeof RawLogEntrySchema>;

const LOG_READ_CHUNK_SIZE_BYTES = 64 * 1024;

function matchesTimestamp(timestamp: string | undefined, filter: LogFilter): boolean {
  const hasTimeFilter = filter.sinceMs != null || filter.untilMs != null;
  if (!(timestamp && hasTimeFilter)) {
    return true;
  }

  const ts = new Date(timestamp).getTime();
  if (Number.isNaN(ts)) {
    return false;
  }
  if (filter.sinceMs != null && ts < filter.sinceMs) {
    return false;
  }
  if (filter.untilMs != null && ts > filter.untilMs) {
    return false;
  }
  return true;
}

function matchesLogFilter(entry: RawLogEntry, filter: LogFilter): boolean {
  if (filter.level && entry.level !== filter.level) {
    return false;
  }
  if (!matchesTimestamp(entry.timestamp, filter)) {
    return false;
  }
  if (filter.search) {
    const msg = entry.message?.toLowerCase() ?? '';
    const comp = typeof entry.context?.component === 'string' ? entry.context.component : undefined;
    if (!(msg.includes(filter.search) || comp?.toLowerCase().includes(filter.search))) {
      return false;
    }
  }
  return true;
}

function toParsedLogEntry(entry: RawLogEntry): ParsedLogEntry {
  return {
    level: entry.level,
    timestamp: entry.timestamp ?? '',
    message: entry.message ?? '',
    component: typeof entry.context?.component === 'string' ? entry.context.component : '',
    context: entry.context ?? {},
  };
}

function parseLogLine(line: string): RawLogEntry | null {
  if (!line) {
    return null;
  }

  try {
    const rawEntry: unknown = JSON.parse(line);
    const parsedEntry = RawLogEntrySchema.safeParse(rawEntry);
    if (!parsedEntry.success) {
      return null;
    }
    return parsedEntry.data;
  } catch {
    return null;
  }
}

interface ChunkResult {
  lineBuffers: Buffer[];
  nextCarry: Buffer;
}

interface ScanState {
  entries: ParsedLogEntry[];
  matchedCount: number;
  hasMore: boolean;
}

const NEWLINE_BYTE = 0x0a;
const CARRIAGE_RETURN_BYTE = 0x0d;
const EMPTY_BUFFER = Buffer.alloc(0);

function splitChunkIntoLineBuffers(
  chunk: Buffer,
  carry: Buffer,
  hasOlderData: boolean
): ChunkResult {
  const joined = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
  const lineBuffers: Buffer[] = [];
  let segmentStart = 0;

  for (let i = 0; i < joined.length; i += 1) {
    if (joined[i] !== NEWLINE_BYTE) {
      continue;
    }

    let segmentEnd = i;
    if (segmentEnd > segmentStart && joined[segmentEnd - 1] === CARRIAGE_RETURN_BYTE) {
      segmentEnd -= 1;
    }
    lineBuffers.push(joined.subarray(segmentStart, segmentEnd));
    segmentStart = i + 1;
  }

  let finalEnd = joined.length;
  if (finalEnd > segmentStart && joined[finalEnd - 1] === CARRIAGE_RETURN_BYTE) {
    finalEnd -= 1;
  }
  lineBuffers.push(joined.subarray(segmentStart, finalEnd));

  if (!hasOlderData) {
    return { lineBuffers, nextCarry: EMPTY_BUFFER };
  }

  const [nextCarry = EMPTY_BUFFER, ...rest] = lineBuffers;
  return {
    lineBuffers: rest,
    nextCarry,
  };
}

function processLine(
  line: string,
  filter: LogFilter,
  pagination: LogPagination,
  targetMatches: number,
  state: ScanState
): void {
  const rawEntry = parseLogLine(line);
  if (!(rawEntry && matchesLogFilter(rawEntry, filter))) {
    return;
  }

  if (state.matchedCount >= pagination.offset && state.entries.length < pagination.limit) {
    state.entries.push(toParsedLogEntry(rawEntry));
  }
  state.matchedCount += 1;
  if (state.matchedCount >= targetMatches) {
    state.hasMore = true;
  }
}

export async function readFilteredLogEntriesPage(
  filePath: string,
  filter: LogFilter,
  pagination: LogPagination
): Promise<LogPageResult> {
  const targetMatches = pagination.offset + pagination.limit + 1;
  const state: ScanState = {
    entries: [],
    matchedCount: 0,
    hasMore: false,
  };

  const file = await open(filePath, 'r');
  try {
    const { size } = await file.stat();
    if (size <= 0) {
      return {
        entries: [],
        total: 0,
        totalIsExact: true,
        hasMore: false,
      };
    }

    let position = size;
    let carry: Buffer = EMPTY_BUFFER;

    while (position > 0 && !state.hasMore) {
      const readSize = Math.min(LOG_READ_CHUNK_SIZE_BYTES, position);
      position -= readSize;

      const buffer = Buffer.alloc(readSize);
      const { bytesRead } = await file.read(buffer, 0, readSize, position);
      const chunk = buffer.subarray(0, bytesRead);
      const chunkResult = splitChunkIntoLineBuffers(chunk, carry, position > 0);
      carry = chunkResult.nextCarry;

      for (let i = chunkResult.lineBuffers.length - 1; i >= 0; i -= 1) {
        processLine(
          chunkResult.lineBuffers[i]?.toString('utf-8') ?? '',
          filter,
          pagination,
          targetMatches,
          state
        );
        if (state.hasMore) {
          break;
        }
      }
    }

    return {
      entries: state.entries,
      total: state.matchedCount,
      totalIsExact: !state.hasMore,
      hasMore: state.hasMore,
    };
  } finally {
    await file.close();
  }
}
