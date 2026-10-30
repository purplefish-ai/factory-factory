import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readClosedSessionTranscriptHeader } from './closed-session-transcript-header';

const schema = z.object({
  sessionId: z.string(),
  metadata: z.object({ provider: z.string(), providerSessionId: z.string() }),
});
const transcript = {
  version: 1,
  sessionId: 'main',
  workspaceId: 'workspace-1',
  metadata: { provider: 'CLAUDE', providerSessionId: 'provider-1', name: 'with "messages": text' },
  messages: [{ type: 'user', content: 'hello' }],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ff-closed-header-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(content: string): string {
  const filePath = join(dir, 'transcript.json');
  writeFileSync(filePath, content);
  return filePath;
}

describe('readClosedSessionTranscriptHeader', () => {
  it('reads the header without parsing the message list', async () => {
    const pretty = JSON.stringify(transcript, null, 2);
    // Corrupt everything after the header: only the header may be parsed.
    const messagesAt = pretty.indexOf('\n  "messages":');
    const filePath = write(`${pretty.slice(0, messagesAt)}\n  "messages": [ not json`);
    await expect(readClosedSessionTranscriptHeader(filePath, schema)).resolves.toEqual({
      sessionId: 'main',
      metadata: { provider: 'CLAUDE', providerSessionId: 'provider-1' },
    });
  });

  it('falls back to the whole file when the header cannot be isolated', async () => {
    const compact = write(JSON.stringify(transcript));
    await expect(readClosedSessionTranscriptHeader(compact, schema)).resolves.toMatchObject({
      sessionId: 'main',
    });

    // Fields written after `messages` are still found by the full parse.
    const { metadata, ...rest } = transcript;
    const reordered = write(JSON.stringify({ ...rest, metadata }, null, 2));
    await expect(readClosedSessionTranscriptHeader(reordered, schema)).resolves.toMatchObject({
      metadata: { providerSessionId: 'provider-1' },
    });
  });

  it('rejects files that do not match the schema', async () => {
    const filePath = write(JSON.stringify({ sessionId: 'main', messages: [] }, null, 2));
    await expect(readClosedSessionTranscriptHeader(filePath, schema)).rejects.toThrow();
    await expect(
      readClosedSessionTranscriptHeader(join(dir, 'missing.json'), schema)
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
