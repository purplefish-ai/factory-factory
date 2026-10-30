import { createReadStream } from 'node:fs';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

const NEWLINE = 0x0a;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;

/**
 * Calls `onLine` with each trimmed, non-empty line and its 1-based line number.
 *
 * With `containing`, only lines that contain that text as it would be written
 * inside a JSON string are decoded and passed on. They are found by a byte
 * search, so skipped lines cost almost nothing.
 */
export async function readNonEmptyJsonlLines(params: {
  filePath: string;
  onLine: (line: string, lineNumber: number) => void | Promise<void>;
  onError: (error: unknown) => void;
  containing?: string;
  chunkBytes?: number;
}): Promise<void> {
  try {
    const needle = params.containing === undefined ? null : jsonStringBytes(params.containing);
    let linesBeforeBlock = 0;
    for await (const block of readLineAlignedBlocks(params.filePath, params.chunkBytes)) {
      let scanned = 0;
      let newlines = 0;
      for (const [start, end] of lineRanges(block, needle)) {
        newlines += countNewlines(block, scanned, start);
        scanned = start;
        // trim() also drops the `\r` of CRLF line endings.
        const trimmed = block.toString('utf8', start, end).trim();
        if (trimmed) {
          await params.onLine(trimmed, linesBeforeBlock + newlines + 1);
        }
      }
      linesBeforeBlock += newlines + countNewlines(block, scanned, block.length);
    }
  } catch (error) {
    params.onError(error);
  }
}

/**
 * Streams a file as blocks that each end on a line boundary. Splitting on the
 * `\n` byte is safe for UTF-8 because that byte never occurs inside a
 * multi-byte character, so each block decodes on its own. The final block may
 * lack a trailing newline. Yields to the event loop between blocks.
 */
async function* readLineAlignedBlocks(
  filePath: string,
  chunkBytes = DEFAULT_CHUNK_BYTES
): AsyncGenerator<Buffer> {
  const stream = createReadStream(filePath, { highWaterMark: chunkBytes });
  let pending: Buffer[] = [];
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const lastNewline = chunk.lastIndexOf(NEWLINE);
      if (lastNewline === -1) {
        pending.push(chunk);
        continue;
      }
      const head = chunk.subarray(0, lastNewline + 1);
      yield pending.length > 0 ? Buffer.concat([...pending, head]) : head;
      pending = lastNewline + 1 < chunk.length ? [chunk.subarray(lastNewline + 1)] : [];
      await yieldToEventLoop();
    }
    if (pending.length > 0) {
      yield Buffer.concat(pending);
    }
  } finally {
    stream.destroy();
  }
}

/** Yields `[start, end)` byte ranges of every line, or only of lines containing `needle`. */
function* lineRanges(block: Buffer, needle: Buffer | null): Generator<[number, number]> {
  let index = needle ? block.indexOf(needle) : 0;
  while (index !== -1 && index < block.length) {
    const start = needle ? block.lastIndexOf(NEWLINE, index) + 1 : index;
    const newline = block.indexOf(NEWLINE, index);
    const end = newline === -1 ? block.length : newline;
    yield [start, end];
    index = needle ? block.indexOf(needle, end) : end + 1;
  }
}

function countNewlines(buffer: Buffer, start: number, end: number): number {
  let count = 0;
  let index = buffer.indexOf(NEWLINE, start);
  while (index !== -1 && index < end) {
    count += 1;
    index = buffer.indexOf(NEWLINE, index + 1);
  }
  return count;
}

function jsonStringBytes(text: string): Buffer {
  const encoded = JSON.stringify(text).slice(1, -1);
  if (encoded.length === 0) {
    throw new Error('JSONL search text must not be empty');
  }
  return Buffer.from(encoded, 'utf8');
}
