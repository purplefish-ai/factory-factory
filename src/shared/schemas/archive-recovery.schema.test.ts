import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  archiveRecoverySchema,
  MAX_ARCHIVE_ENTRY_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_TOTAL_BYTES,
} from './archive-recovery.schema';

function entry(padding = '') {
  const transcript = JSON.stringify({
    version: 1,
    sessionId: 'session',
    workspaceId: 'workspace',
    metadata: {
      padding,
      name: 'saved',
      workflow: 'ratchet',
      provider: 'CODEX',
      codexAccountId: 'original-account',
      providerSessionId: 'native',
      model: 'model',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-02T00:00:00.000Z',
    },
    messages: [],
  });
  return {
    id: 'archive',
    workspaceId: 'workspace',
    sessionId: 'session',
    name: 'saved',
    workflow: 'ratchet',
    provider: 'CODEX' as const,
    model: 'model',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-02T00:00:00.000Z',
    archiveKey: 'a'.repeat(64),
    sha256: createHash('sha256').update(transcript).digest('hex'),
    byteLength: Buffer.byteLength(transcript),
    transcript,
  };
}

describe('archive recovery wire boundary', () => {
  it('requires strict version 1 and retains exact UTF8 bytes and account identity', () => {
    const original = entry();
    expect(archiveRecoverySchema.parse({ version: 1, entries: [original] }).entries[0]).toEqual(
      original
    );
    for (const invalid of [
      { version: 2, entries: [] },
      { version: 1, entries: [], path: '/tmp' },
      { version: 1, entries: [{ ...original, transcriptPath: '../outside' }] },
    ]) {
      expect(archiveRecoverySchema.safeParse(invalid).success).toBe(false);
    }
  });
  it('rejects duplicate ids and logical keys and traversal identifiers', () => {
    const original = entry();
    for (const entries of [
      [original, { ...original, archiveKey: 'b'.repeat(64) }],
      [original, { ...original, id: 'other' }],
      [{ ...original, id: '../escape' }],
    ]) {
      expect(archiveRecoverySchema.safeParse({ version: 1, entries }).success).toBe(false);
    }
  });
  it('checks declared UTF8 length independently of capacity', () => {
    const original = entry();
    const result = archiveRecoverySchema.safeParse({
      version: 1,
      entries: [{ ...original, byteLength: original.byteLength + 1 }],
    });
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['entries', 0, 'transcript'],
        message: 'Invalid archive UTF-8 byte length or encoding',
      }),
    ]);
  });

  function sizedEntry(bytes: number) {
    return entry('x'.repeat(bytes - entry().byteLength));
  }

  function uniqueEntries(original: ReturnType<typeof entry>, count: number) {
    return Array.from({ length: count }, (_, index) => ({
      ...original,
      id: `archive-${index}`,
      archiveKey: createHash('sha256').update(`archive-${index}`).digest('hex'),
    }));
  }

  it('rejects a valid oversized transcript with matching length and checksum at the entry cap', () => {
    const atLimit = sizedEntry(MAX_ARCHIVE_ENTRY_BYTES);
    expect(archiveRecoverySchema.safeParse({ version: 1, entries: [atLimit] }).success).toBe(true);
    const oversized = sizedEntry(MAX_ARCHIVE_ENTRY_BYTES + 1);
    expect(Buffer.byteLength(oversized.transcript)).toBe(oversized.byteLength);
    const result = archiveRecoverySchema.safeParse({ version: 1, entries: [oversized] });
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        code: 'too_big',
        path: ['entries', 0, 'byteLength'],
        maximum: MAX_ARCHIVE_ENTRY_BYTES,
      })
    );
  });

  it('bounds entry count with otherwise valid unique entries', () => {
    const entries = uniqueEntries(entry(), MAX_ARCHIVE_ENTRIES + 1);
    expect(
      archiveRecoverySchema.safeParse({ version: 1, entries: entries.slice(0, -1) }).success
    ).toBe(true);
    const result = archiveRecoverySchema.safeParse({ version: 1, entries });
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        code: 'too_big',
        path: ['entries'],
        maximum: MAX_ARCHIVE_ENTRIES,
      }),
    ]);
  });

  it('bounds decoded aggregate bytes independently of entry count, duplicate and entry limits', () => {
    const entries = uniqueEntries(
      sizedEntry(MAX_ARCHIVE_ENTRY_BYTES),
      MAX_ARCHIVE_TOTAL_BYTES / MAX_ARCHIVE_ENTRY_BYTES
    );
    expect(archiveRecoverySchema.safeParse({ version: 1, entries }).success).toBe(true);
    const extra = { ...entry(), id: 'extra', archiveKey: 'f'.repeat(64) };
    const result = archiveRecoverySchema.safeParse({ version: 1, entries: [...entries, extra] });
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['entries'],
        message: 'Archive package exceeds total byte limit',
      }),
    ]);
  });
  it.each([
    'workspaceId',
    'sessionId',
    'name',
    'workflow',
    'provider',
    'model',
    'startedAt',
    'completedAt',
  ])('rejects inconsistent envelope linkage: %s', (field) => {
    const original = entry();
    const changed = {
      ...original,
      [field]: field.endsWith('At')
        ? '2026-02-01T00:00:00.000Z'
        : field === 'provider'
          ? 'CLAUDE'
          : 'changed',
    };
    expect(archiveRecoverySchema.safeParse({ version: 1, entries: [changed] }).success).toBe(false);
  });
  it.each(['not json', '{"version":2}', '{"version":1,"messages":{}}'])(
    'rejects malformed transcript %s',
    (transcript) => {
      expect(
        archiveRecoverySchema.safeParse({
          version: 1,
          entries: [{ ...entry(), transcript, byteLength: Buffer.byteLength(transcript) }],
        }).success
      ).toBe(false);
    }
  );
});
