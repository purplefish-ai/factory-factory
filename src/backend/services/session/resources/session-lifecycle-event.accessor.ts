import type { SessionLifecycleEvent } from '@prisma-gen/client';
import { prisma } from '@/backend/db';
import type { SessionLifecycleEventKind, SessionLifecycleEventReason } from '@/shared/core';

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

export interface SessionLifecycleEventStore {
  upsert(input: UpsertSessionLifecycleEventInput): Promise<SessionLifecycleEventRecord>;
  findBySessionId(sessionId: string): Promise<SessionLifecycleEventRecord[]>;
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
}

export const sessionLifecycleEventAccessor = new PrismaSessionLifecycleEventAccessor();
