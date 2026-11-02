import type { z } from 'zod';
import { getClosedSessionArchiveKey } from '@/backend/services/session/service/lifecycle/closed-session-identity';
import {
  archiveTranscriptSchema,
  type ArchiveRecovery,
} from '@/shared/schemas/archive-recovery.schema';

/** Full schema validation narrows the raw INPUT, preserving absent stream input. */
function isIdentitySnapshot(value: unknown): value is z.input<typeof archiveTranscriptSchema> {
  return archiveTranscriptSchema.safeParse(value).success;
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
