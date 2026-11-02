import { randomUUID } from 'node:crypto';
import { prisma } from '@/backend/db';
import {
  ackMailInputSchema,
  listMailInputSchema,
  readMailInputSchema,
  workspaceMailSendMetadataSchema,
  workspaceMailSummarySchema,
  type AckMailInput,
  type ListMailInput,
  type ReadMailInput,
  type WorkspaceMailListResult,
  type WorkspaceMailReadResult,
  type WorkspaceMailSendMetadata,
  type WorkspaceMailWakeClaim,
} from '@/shared/workspace-mail';
import type { Prisma, WorkspaceNotification } from '@prisma-gen/client';

interface CreateNotificationInput extends WorkspaceMailSendMetadata {
  workspaceId: string;
  sourceWorkspaceId: string;
  sourceWorkspaceName: string;
  sourceProjectName: string;
  message: string;
  direction?: 'CHILD_TO_PARENT' | 'PARENT_TO_CHILD';
}
const summarySelect = {
  id: true,
  revision: true,
  subject: true,
  preview: true,
  kind: true,
  taskKey: true,
  taskRevision: true,
  sourceWorkspaceId: true,
  sourceWorkspaceName: true,
  sourceProjectName: true,
  createdAt: true,
  readAt: true,
  acknowledgedAt: true,
  supersededAt: true,
} satisfies Prisma.WorkspaceNotificationSelect;
const actionable = { acknowledgedAt: null, supersededAt: null, kind: { not: 'PROGRESS' } };
const WAKE_LEASE_MS = 30_000;
function textBoundary(text: string, offset: number): number {
  const bounded = Math.min(offset, text.length);
  const current = text.charCodeAt(bounded);
  const previous = text.charCodeAt(bounded - 1);
  return current >= 0xdc_00 && current <= 0xdf_ff && previous >= 0xd8_00 && previous <= 0xdb_ff
    ? bounded - 1
    : bounded;
}
function summarize(row: Prisma.WorkspaceNotificationGetPayload<{ select: typeof summarySelect }>) {
  // SQLite SUBSTR used by the legacy migration counts Unicode code points.
  // The API budget, like JavaScript body offsets, counts UTF-16 code units.
  return workspaceMailSummarySchema.parse({
    ...row,
    preview: row.preview.slice(0, textBoundary(row.preview, 160)),
  });
}

class WorkspaceNotificationAccessor {
  create(input: CreateNotificationInput): Promise<WorkspaceNotification> {
    const metadata = workspaceMailSendMetadataSchema.parse(input);
    const {
      workspaceId,
      sourceWorkspaceId,
      sourceWorkspaceName,
      sourceProjectName,
      message,
      direction,
    } = input;
    return prisma.$transaction(async (tx) => {
      const state = await tx.workspaceMailState.upsert({
        where: { workspaceId },
        create: { workspaceId, revision: 1 },
        update: { revision: { increment: 1 } },
      });
      let supersededAt: Date | null = null;
      if (metadata.kind === 'PROGRESS' && metadata.taskKey) {
        const latest = await tx.workspaceNotification.aggregate({
          where: { workspaceId, sourceWorkspaceId, kind: 'PROGRESS', taskKey: metadata.taskKey },
          _max: { taskRevision: true },
        });
        if (
          metadata.taskRevision !== undefined &&
          latest._max.taskRevision !== null &&
          metadata.taskRevision < latest._max.taskRevision
        ) {
          supersededAt = new Date();
        } else {
          await tx.workspaceNotification.updateMany({
            where: {
              workspaceId,
              sourceWorkspaceId,
              kind: 'PROGRESS',
              taskKey: metadata.taskKey,
              supersededAt: null,
            },
            data: { supersededAt: new Date() },
          });
        }
      }
      return tx.workspaceNotification.create({
        data: {
          workspaceId,
          sourceWorkspaceId,
          sourceWorkspaceName,
          sourceProjectName,
          message,
          preview: message.slice(0, textBoundary(message, 160)),
          revision: state.revision,
          direction,
          ...metadata,
          supersededAt,
        },
      });
    });
  }

  listMail(input: ListMailInput): Promise<WorkspaceMailListResult> {
    const { workspaceId, cursor, limit, unreadOnly, includeSuperseded, kinds } =
      listMailInputSchema.parse(input);
    return prisma.$transaction(async (tx) => {
      const state = await tx.workspaceMailState.findUnique({ where: { workspaceId } });
      const rows = await tx.workspaceNotification.findMany({
        where: {
          workspaceId,
          ...(!includeSuperseded ? { supersededAt: null } : {}),
          ...(cursor ? { revision: { lt: cursor } } : {}),
          ...(unreadOnly ? { readAt: null, acknowledgedAt: null, supersededAt: null } : {}),
          ...(kinds ? { kind: { in: kinds } } : {}),
        },
        orderBy: { revision: 'desc' },
        take: limit + 1,
        select: summarySelect,
      });
      const items = rows.slice(0, limit).map((row) => summarize(row));
      return {
        items,
        wakeAmbiguous: state?.wakeAmbiguousAt != null,
        nextCursor: rows.length > limit ? (items.at(-1)?.revision ?? null) : null,
        revision: state?.revision ?? 0,
      };
    });
  }

  readMail(input: ReadMailInput): Promise<WorkspaceMailReadResult> {
    const { workspaceId, ids, maxChars, offset } = readMailInputSchema.parse(input);
    return prisma.$transaction(async (tx) => {
      const rows = await tx.workspaceNotification.findMany({
        where: { workspaceId, id: { in: ids } },
        select: { ...summarySelect, message: true },
      });
      let remaining = maxChars;
      const now = new Date();
      const items = [...new Set(ids)].flatMap((id) => {
        const row = rows.find((candidate) => candidate.id === id);
        if (!row) {
          return [];
        }
        const start = textBoundary(row.message, offset);
        const body = row.message.slice(start, textBoundary(row.message, start + remaining));
        if (maxChars === 1 && remaining > 0 && body.length === 0 && start < row.message.length) {
          throw new Error(
            'Mail character budget cannot fit the next Unicode character; increase maxChars to at least 2.'
          );
        }
        remaining -= body.length;
        const end = start + body.length;
        return [
          {
            ...summarize(row),
            // Empty budget entries remain unread and provide an explicit continuation offset.
            readAt: body.length > 0 ? (row.readAt ?? now) : row.readAt,
            body,
            offset: start,
            nextOffset: end < row.message.length ? end : null,
          },
        ];
      });
      const readIds = items.filter((item) => item.body.length > 0).map((item) => item.id);
      await tx.workspaceNotification.updateMany({
        where: { workspaceId, id: { in: readIds }, readAt: null },
        data: { readAt: now },
      });
      const state = await tx.workspaceMailState.findUnique({ where: { workspaceId } });
      return { items, revision: state?.revision ?? 0 };
    });
  }

  ackMail(input: AckMailInput) {
    const { workspaceId, ids, throughRevision } = ackMailInputSchema.parse(input);
    return prisma.$transaction(async (tx) => {
      const result = await tx.workspaceNotification.updateMany({
        where: {
          workspaceId,
          id: { in: ids },
          revision: { lte: throughRevision },
          acknowledgedAt: null,
        },
        data: { acknowledgedAt: new Date() },
      });
      const state = await tx.workspaceMailState.findUnique({ where: { workspaceId } });
      const inspected = await tx.workspaceNotification.count({
        where: {
          workspaceId,
          id: { in: ids },
          revision: { lte: throughRevision },
          acknowledgedAt: { not: null },
        },
      });
      if (state && inspected > 0) {
        await tx.workspaceMailState.update({
          where: { workspaceId },
          data: {
            wakeAcknowledgedRevision: Math.max(
              state.wakeAcknowledgedRevision,
              Math.min(throughRevision, state.revision)
            ),
          },
        });
      }
      return { acknowledged: result.count, revision: state?.revision ?? 0 };
    });
  }

  claimWake({ workspaceId }: { workspaceId: string }): Promise<WorkspaceMailWakeClaim | null> {
    return prisma.$transaction(async (tx) => {
      // Obtain SQLite's write lock before inspecting the latch, also across processes.
      await tx.workspaceMailState.updateMany({
        where: { workspaceId },
        data: { revision: { increment: 0 } },
      });
      const state = await tx.workspaceMailState.findUnique({ where: { workspaceId } });
      if (!state) {
        return null;
      }
      if (state.wakeAmbiguousAt || state.notifiedRevision > state.wakeAcknowledgedRevision) {
        return null;
      }
      if (
        state.claimId &&
        state.claimedAt &&
        state.claimedAt.getTime() + WAKE_LEASE_MS > Date.now()
      ) {
        return null;
      }
      const actionableRevision = await tx.workspaceNotification.aggregate({
        where: { workspaceId, ...actionable, revision: { gt: state.notifiedRevision } },
        _max: { revision: true },
      });
      const revision = actionableRevision._max.revision;
      if (revision === null) {
        return null;
      }
      const claimId = randomUUID();
      await tx.workspaceMailState.update({
        where: { workspaceId },
        data: {
          claimId,
          claimRevision: revision,
          claimedAt: new Date(),
        },
      });
      return { workspaceId, revision, claimId };
    });
  }

  async settleWake({ workspaceId, revision, claimId }: WorkspaceMailWakeClaim): Promise<boolean> {
    const result = await prisma.workspaceMailState.updateMany({
      where: { workspaceId, claimId, claimRevision: revision },
      data: {
        notifiedRevision: revision,
        claimId: null,
        claimRevision: null,
        claimedAt: null,
        wakeAmbiguousAt: null,
      },
    });
    return result.count === 1;
  }

  async releaseWake({ workspaceId, revision, claimId }: WorkspaceMailWakeClaim): Promise<void> {
    await prisma.workspaceMailState.updateMany({
      where: { workspaceId, claimId, claimRevision: revision, wakeAmbiguousAt: null },
      data: { claimId: null, claimRevision: null, claimedAt: null },
    });
  }

  async quarantineWake({
    workspaceId,
    revision,
    claimId,
  }: WorkspaceMailWakeClaim): Promise<boolean> {
    const result = await prisma.workspaceMailState.updateMany({
      where: { workspaceId, claimId, claimRevision: revision },
      data: { wakeAmbiguousAt: new Date() },
    });
    return result.count === 1;
  }

  async disarmWake({ workspaceId, revision, claimId }: WorkspaceMailWakeClaim): Promise<boolean> {
    const result = await prisma.workspaceMailState.updateMany({
      where: { workspaceId, claimId, claimRevision: revision },
      data: { wakeAmbiguousAt: null, claimedAt: new Date() },
    });
    return result.count === 1;
  }

  async retryWake({ workspaceId }: { workspaceId: string }): Promise<boolean> {
    const result = await prisma.workspaceMailState.updateMany({
      where: { workspaceId, wakeAmbiguousAt: { not: null } },
      data: { wakeAmbiguousAt: null, claimId: null, claimRevision: null, claimedAt: null },
    });
    return result.count === 1;
  }

  nextWakeRetryAt({ workspaceId }: { workspaceId: string }): Promise<Date | null> {
    return prisma.$transaction(async (tx) => {
      const state = await tx.workspaceMailState.findUnique({ where: { workspaceId } });
      if (!(state?.claimId && state.claimedAt) || state.wakeAmbiguousAt) {
        return null;
      }
      if (state.notifiedRevision > state.wakeAcknowledgedRevision) {
        return null;
      }
      if (
        (await tx.workspaceNotification.count({
          where: { workspaceId, ...actionable, revision: { gt: state.notifiedRevision } },
        })) === 0
      ) {
        return null;
      }
      return new Date(state.claimedAt.getTime() + WAKE_LEASE_MS);
    });
  }

  findById(id: string): Promise<WorkspaceNotification | null> {
    return prisma.workspaceNotification.findUnique({ where: { id } });
  }

  findPending(workspaceId: string): Promise<WorkspaceNotification[]> {
    return prisma.workspaceNotification.findMany({
      where: { workspaceId, acknowledgedAt: null, supersededAt: null },
      orderBy: { revision: 'asc' },
    });
  }

  async markDelivered(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await prisma.workspaceNotification.updateMany({
      where: { id: { in: ids } },
      data: { deliveredAt: new Date() },
    });
  }

  countPending(workspaceId: string): Promise<number> {
    return prisma.workspaceNotification.count({
      where: { workspaceId, acknowledgedAt: null, supersededAt: null },
    });
  }
}
export const workspaceNotificationAccessor = new WorkspaceNotificationAccessor();
