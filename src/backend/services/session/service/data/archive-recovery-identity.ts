import { z } from 'zod';
import type { ArchiveRecovery } from '@/shared/schemas/archive-recovery.schema';
import { closedSessionTranscriptSchema } from '@/shared/schemas/closed-session-transcript.schema';
import { getClosedSessionArchiveKey } from '../lifecycle/closed-session-identity';

const identitySnapshotSchema = closedSessionTranscriptSchema.extend({
  metadata: closedSessionTranscriptSchema.shape.metadata.extend({
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    conversationEpoch: z.number().int().nonnegative().optional(),
  }),
});

/** Full schema validation narrows the raw INPUT, preserving absent stream input. */
function isIdentitySnapshot(value: unknown): value is z.input<typeof identitySnapshotSchema> {
  return identitySnapshotSchema.safeParse(value).success;
}

export function validateModernArchiveIdentity(entry: ArchiveRecovery['entries'][number]): void {
  const snapshot: unknown = JSON.parse(entry.transcript);
  if (!isIdentitySnapshot(snapshot)) {
    throw new Error(`Invalid content archive snapshot: ${entry.id}`);
  }
  const metadata = snapshot.metadata;
  const key = getClosedSessionArchiveKey({
    workspaceId: snapshot.workspaceId,
    sessionId: snapshot.sessionId,
    provider: metadata.provider,
    providerSessionId: metadata.providerSessionId,
    codexAccountId: metadata.codexAccountId,
    conversationEpoch: metadata.conversationEpoch,
    startedAt: new Date(metadata.startedAt),
    messages: snapshot.messages,
  });
  if (key !== entry.archiveKey) {
    throw new Error(`Invalid content archive identity: ${entry.id}`);
  }
}
