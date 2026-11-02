import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  archiveRecoverySchema,
  MAX_ARCHIVE_ENTRY_BYTES,
  MAX_ARCHIVE_ENTRIES,
} from './archive-recovery.schema';

function entry() {
  const transcript = JSON.stringify({
    version: 1,
    sessionId: 'session',
    workspaceId: 'workspace',
    metadata: {
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
  it('bounds entry count and bytes and checks declared UTF8 length', () => {
    const original = entry();
    for (const entries of [
      [{ ...original, byteLength: original.byteLength + 1 }],
      [{ ...original, transcript: 'x'.repeat(MAX_ARCHIVE_ENTRY_BYTES + 1) }],
      Array.from({ length: MAX_ARCHIVE_ENTRIES + 1 }, () => original),
    ]) {
      expect(archiveRecoverySchema.safeParse({ version: 1, entries }).success).toBe(false);
    }
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
