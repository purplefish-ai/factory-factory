import { prisma } from '@/backend/db';
import { type SessionLifecycleEventKind, SessionLifecycleEventReason } from '@/shared/core';
import { retainedReferenceAllowed, type RecoveryImportedIds } from '@/shared/recovery-graph';
import type { ExportData } from '@/shared/schemas/export-data.schema';
import type { Prisma, SessionLifecycleEvent } from '@prisma-gen/client';

export type SessionLifecycleEventRecord = SessionLifecycleEvent;

export interface UpsertSessionLifecycleEventInput {
  workspaceId: string;
  sessionId: string;
  kind: SessionLifecycleEventKind;
  reason: SessionLifecycleEventReason;
  message: string;
  dedupeKey: string;
  createdAt: Date;
}

/** Reasons that mean the provider session itself failed, not a deliberate stop. */
export const SESSION_FAILURE_REASONS: readonly SessionLifecycleEventReason[] = [
  SessionLifecycleEventReason.PROVIDER_ERROR,
  SessionLifecycleEventReason.PROMPT_TIMEOUT,
  SessionLifecycleEventReason.UNEXPECTED_EXIT,
];

export interface SessionLifecycleEventStore {
  upsert(input: UpsertSessionLifecycleEventInput): Promise<SessionLifecycleEventRecord>;
  findBySessionId(sessionId: string): Promise<SessionLifecycleEventRecord[]>;
  findLatestFailureByWorkspaceId(workspaceId: string): Promise<SessionLifecycleEventRecord | null>;
}

class PrismaSessionLifecycleEventAccessor implements SessionLifecycleEventStore {
  upsert(input: UpsertSessionLifecycleEventInput): Promise<SessionLifecycleEventRecord> {
    return prisma.sessionLifecycleEvent.upsert({
      where: {
        sessionId_dedupeKey: {
          sessionId: input.sessionId,
          dedupeKey: input.dedupeKey,
        },
      },
      create: input,
      update: {},
    });
  }

  findBySessionId(sessionId: string): Promise<SessionLifecycleEventRecord[]> {
    return prisma.sessionLifecycleEvent.findMany({
      where: { sessionId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  findLatestFailureByWorkspaceId(workspaceId: string): Promise<SessionLifecycleEventRecord | null> {
    return prisma.sessionLifecycleEvent.findFirst({
      where: { workspaceId, reason: { in: [...SESSION_FAILURE_REASONS] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }
}

export const sessionLifecycleEventAccessor = new PrismaSessionLifecycleEventAccessor();

export async function restoreRecoveryLifecycleEvents(
  tx: Prisma.TransactionClient,
  data: ExportData['data'],
  ids: RecoveryImportedIds
) {
  const sourceSessions = new Set(data.agentSessions.map((row) => row.id));
  for (const row of data.durable?.sessionLifecycleEvent ?? []) {
    if (
      !(
        ids.workspaces.has(row.workspaceId) &&
        retainedReferenceAllowed(
          sourceSessions,
          ids.sessions,
          row.sessionId,
          !!(await tx.agentSession.findUnique({ where: { id: row.sessionId } }))
        )
      ) ||
      (await tx.sessionLifecycleEvent.findFirst({
        where: { OR: [{ id: row.id }, { sessionId: row.sessionId, dedupeKey: row.dedupeKey }] },
      }))
    ) {
      continue;
    }
    await tx.sessionLifecycleEvent.create({ data: row });
  }
}
