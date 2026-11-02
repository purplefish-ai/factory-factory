import { z } from 'zod';
import { closedSessionTranscriptSchema } from './closed-session-transcript.schema';

// Limits apply to decoded transcript UTF-8 bytes, independently of JSON escaping.
export const MAX_ARCHIVE_ENTRIES = 10_000;
export const MAX_ARCHIVE_ENTRY_BYTES = 16 * 1024 * 1024;
export const MAX_ARCHIVE_TOTAL_BYTES = 256 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(1024);
const transcriptSchema = closedSessionTranscriptSchema
  .extend({
    metadata: closedSessionTranscriptSchema.shape.metadata.extend({
      startedAt: z.iso.datetime(),
      completedAt: z.iso.datetime(),
      conversationEpoch: z.number().int().nonnegative().optional(),
    }),
  })
  .strict();

const archiveRecoveryEntrySchema = z
  .strictObject({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    workspaceId: identity,
    sessionId: identity,
    name: z.string().nullable(),
    workflow: z.string(),
    provider: z.enum(['CLAUDE', 'CODEX']),
    model: z.string(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    archiveKey: digest,
    // Omission preserves the strict modern contract for earlier v1 packages.
    identity: z.enum(['content-v1', 'legacy-v1']).optional(),
    sha256: digest,
    byteLength: z.number().int().positive().max(MAX_ARCHIVE_ENTRY_BYTES),
    transcript: z.string().max(MAX_ARCHIVE_ENTRY_BYTES),
  })
  .superRefine((entry, ctx) => {
    const bytes = new TextEncoder().encode(entry.transcript);
    if (
      bytes.byteLength !== entry.byteLength ||
      bytes.byteLength > MAX_ARCHIVE_ENTRY_BYTES ||
      new TextDecoder().decode(bytes) !== entry.transcript
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['transcript'],
        message: 'Invalid archive UTF-8 byte length or encoding',
      });
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(entry.transcript);
    } catch {
      ctx.addIssue({ code: 'custom', path: ['transcript'], message: 'Invalid archive JSON' });
      return;
    }
    const parsed = transcriptSchema.safeParse(json);
    if (!parsed.success) {
      ctx.addIssue({
        code: 'custom',
        path: ['transcript'],
        message: 'Invalid archive transcript envelope',
      });
      return;
    }
    const transcript = parsed.data;
    if (
      transcript.workspaceId !== entry.workspaceId ||
      transcript.sessionId !== entry.sessionId ||
      (['name', 'workflow', 'provider', 'model', 'startedAt'] as const).some(
        (field) => transcript.metadata[field] !== entry[field]
      ) ||
      (entry.identity !== 'legacy-v1' && transcript.metadata.completedAt !== entry.completedAt)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['transcript'],
        message: 'Archive transcript identity/history mismatch',
      });
    }
  });

export const archiveRecoverySchema = z
  .strictObject({
    version: z.literal(1),
    entries: z.array(archiveRecoveryEntrySchema).max(MAX_ARCHIVE_ENTRIES),
  })
  .superRefine(({ entries }, ctx) => {
    const ids = new Set<string>();
    const keys = new Set<string>();
    let bytes = 0;
    for (const [index, entry] of entries.entries()) {
      bytes += entry.byteLength;
      if (ids.has(entry.id) || keys.has(entry.archiveKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', index],
          message: 'Duplicate archive id or logical key',
        });
      }
      ids.add(entry.id);
      keys.add(entry.archiveKey);
    }
    if (bytes > MAX_ARCHIVE_TOTAL_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['entries'],
        message: 'Archive package exceeds total byte limit',
      });
    }
  });

export type ArchiveRecovery = z.infer<typeof archiveRecoverySchema>;
