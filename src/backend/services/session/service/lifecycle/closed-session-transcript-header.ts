import { open, readFile } from 'node:fs/promises';
import type { z } from 'zod';

const HEADER_PROBE_BYTES = 64 * 1024;
// `JSON.stringify(transcript, null, 2)` writes every top-level field before
// `messages`, and a raw newline can only occur between tokens, so this byte
// sequence marks where the small header ends and the large message list begins.
const MESSAGES_KEY = Buffer.from('\n  "messages":', 'utf8');

/**
 * Parses a closed-session transcript's top-level fields without reading or
 * parsing its message list. Falls back to parsing the whole file when the
 * header cannot be isolated or does not match `schema`.
 */
export async function readClosedSessionTranscriptHeader<T>(
  filePath: string,
  schema: z.ZodType<T>
): Promise<T> {
  const header = await readHeaderPrefix(filePath);
  if (header !== null) {
    const parsed = schema.safeParse(header);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return schema.parse(JSON.parse(await readFile(filePath, 'utf-8')));
}

async function readHeaderPrefix(filePath: string): Promise<unknown> {
  const handle = await open(filePath, 'r');
  let prefix: string;
  try {
    const probe = Buffer.alloc(HEADER_PROBE_BYTES);
    const { bytesRead } = await handle.read(probe, 0, HEADER_PROBE_BYTES, 0);
    const keyIndex = probe.subarray(0, bytesRead).indexOf(MESSAGES_KEY);
    if (keyIndex === -1) {
      return null;
    }
    prefix = probe.toString('utf8', 0, keyIndex).replace(/,\s*$/, '');
  } finally {
    await handle.close();
  }
  try {
    return JSON.parse(`${prefix}\n}`);
  } catch {
    return null;
  }
}
