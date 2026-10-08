import type { Prisma } from '@prisma-gen/client';
import type { z } from 'zod';
import { prisma } from '@/backend/db';
import type { ClaimedPRDelivery, PRDeliveryRequest, PREventDraft } from '@/shared/pr-monitoring';
import { prMonitoringEventPayloadSchema } from '@/shared/schemas/pr-event.schema';
import { prEventBackupSchema } from '@/shared/schemas/pr-monitoring-backup.schema';

function validateImportedTarget(event: z.infer<typeof prEventBackupSchema>, workspaceId: string) {
  if (
    event.payload.kind === 'MONITORING_ENABLED'
      ? event.payload.workspaceId !== workspaceId || event.prId !== null
      : event.payload.target.workspaceId !== workspaceId || event.payload.target.prId !== event.prId
  ) {
    throw new Error('Imported event payload target is invalid');
  }
}
class WorkspacePrEventAccessor {
  async restoreBackup(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    rawEvents: z.infer<typeof prEventBackupSchema>[]
  ) {
    for (const raw of rawEvents) {
      const event = prEventBackupSchema.parse(raw);
      if (
        event.workspaceId !== workspaceId ||
        (event.prId &&
          !(await tx.workspacePR.findFirst({ where: { id: event.prId, workspaceId } })))
      ) {
        throw new Error('Imported PR event target is invalid');
      }
      validateImportedTarget(event, workspaceId);
      await tx.workspacePREvent.create({
        data: {
          ...event,
          claimedAt: event.claimedAt ? new Date(event.claimedAt) : null,
          deliveredAt: event.deliveredAt ? new Date(event.deliveredAt) : null,
          createdAt: new Date(event.createdAt),
        },
      });
    }
  }
  async insert(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    prId: string | null,
    drafts: PREventDraft[]
  ) {
    if (
      prId &&
      !(await tx.workspacePR.findFirst({ where: { id: prId, workspaceId, detachedAt: null } }))
    ) {
      throw new Error('PR target belongs to another workspace or is detached');
    }
    const ids: string[] = [];
    for (const draft of drafts) {
      const payload = prMonitoringEventPayloadSchema.parse(draft.payload);
      if (
        payload.kind === 'MONITORING_ENABLED'
          ? prId !== null || payload.workspaceId !== workspaceId
          : payload.target.workspaceId !== workspaceId || payload.target.prId !== prId
      ) {
        throw new Error('Event target does not match its association');
      }
      const row = await tx.workspacePREvent.upsert({
        where: {
          workspaceId_deduplicationKey: { workspaceId, deduplicationKey: draft.deduplicationKey },
        },
        update: {},
        create: { workspaceId, prId, ...draft, payload },
      });
      ids.push(row.id);
    }
    return ids;
  }
  addEnabledControl(workspaceId: string, bindingRevision: number, replyToPrComments: boolean) {
    return prisma.$transaction(async (tx) => {
      const config = await tx.workspacePRMonitoring.findFirst({
        where: { workspaceId, bindingRevision, enabled: true, recipientSessionId: { not: null } },
      });
      if (!config) {
        return [];
      }
      return this.insert(tx, workspaceId, null, [
        {
          kind: 'MONITORING_ENABLED',
          deduplicationKey: `enabled:${bindingRevision}`,
          payload: { kind: 'MONITORING_ENABLED', workspaceId, bindingRevision, replyToPrComments },
        },
      ]);
    });
  }
  listPending(workspaceId: string, prId?: string | null) {
    return prisma.workspacePREvent.findMany({
      where: {
        workspaceId,
        ...(prId !== undefined ? { prId } : {}),
        state: { in: ['PENDING', 'DISPATCHING'] },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }
  listForPR(tx: Prisma.TransactionClient, prId: string) {
    return tx.workspacePREvent.findMany({
      where: { prId, state: { in: ['PENDING', 'DISPATCHING', 'DELIVERED'] } },
    });
  }
  supersede(tx: Prisma.TransactionClient, ids: string[]) {
    return tx.workspacePREvent.updateMany({
      where: { id: { in: ids }, state: 'PENDING', deliveryId: null },
      data: { state: 'SUPERSEDED' },
    });
  }
  claimDelivery(
    request: PRDeliveryRequest,
    input: Omit<ClaimedPRDelivery, 'bindingRevision' | 'attempt'>
  ): Promise<ClaimedPRDelivery | null> {
    return prisma.$transaction(async (tx) => {
      const config = await tx.workspacePRMonitoring.findFirst({
        where: {
          workspaceId: request.workspaceId,
          enabled: true,
          recipientSessionId: input.sessionId,
          bindingRevision: request.bindingRevision,
          deliveryPauseReason: null,
          workspace: { status: 'READY' },
        },
      });
      if (!(config && input.eventIds.length)) {
        return null;
      }
      if (
        request.prId &&
        !(await tx.workspacePR.findFirst({
          where: { id: request.prId, workspaceId: request.workspaceId, detachedAt: null },
        }))
      ) {
        return null;
      }
      const rows = await tx.workspacePREvent.findMany({
        where: {
          id: { in: input.eventIds },
          workspaceId: request.workspaceId,
          prId: request.prId,
          state: 'PENDING',
        },
      });
      if (
        rows.length !== input.eventIds.length ||
        rows.some(
          (e) =>
            e.deliveryId &&
            (e.deliveryId !== input.deliveryId ||
              e.deliverySessionId !== input.sessionId ||
              e.deliveryText !== input.text)
        )
      ) {
        return null;
      }
      const session = await tx.agentSession.findFirst({
        where: { id: input.sessionId, workspaceId: request.workspaceId },
      });
      if (
        !session?.providerSessionId ||
        rows.some(
          (row) =>
            row.deliveryId &&
            (!row.deliveryProviderSessionId ||
              row.deliveryProvider !== session.provider ||
              row.deliveryProviderSessionId !== session.providerSessionId)
        )
      ) {
        return null;
      }
      const identity = {
        deliveryProvider: session.provider,
        deliveryProviderSessionId: session.providerSessionId,
      };
      const attempt = Math.max(...rows.map((e) => e.attempts)) + 1;
      const updated = await tx.workspacePREvent.updateMany({
        where: { id: { in: input.eventIds }, state: 'PENDING' },
        data: {
          state: 'DISPATCHING',
          ...identity,
          attempts: attempt,
          deliveryId: input.deliveryId,
          deliverySessionId: input.sessionId,
          deliveryBindingRevision: request.bindingRevision,
          deliveryText: input.text,
          claimedAt: new Date(),
        },
      });
      if (updated.count !== rows.length) {
        throw new Error('Lost event claim');
      }
      return { ...input, ...identity, bindingRevision: request.bindingRevision, attempt };
    });
  }
  async settleDelivery(input: {
    deliveryId: string;
    sessionId: string;
    bindingRevision: number;
    result: 'delivered' | 'retry' | 'failed';
  }) {
    const result = await prisma.workspacePREvent.updateMany({
      where: {
        deliveryId: input.deliveryId,
        deliverySessionId: input.sessionId,
        deliveryBindingRevision: input.bindingRevision,
        state: 'DISPATCHING',
      },
      data:
        input.result === 'delivered'
          ? { state: 'DELIVERED', deliveredAt: new Date() }
          : { state: 'PENDING' },
    });
    return result.count > 0;
  }
  deferBusy(deliveryId: string) {
    return prisma.workspacePREvent.updateMany({
      where: { deliveryId, state: 'DISPATCHING', attempts: { gt: 0 } },
      data: { state: 'PENDING', attempts: { decrement: 1 } },
    });
  }
  renewRetryAllowance(tx: Prisma.TransactionClient, workspaceId: string) {
    return tx.workspacePREvent.updateMany({
      where: { workspaceId, state: { in: ['PENDING', 'DISPATCHING'] }, attempts: { gte: 3 } },
      data: { attempts: 0 },
    });
  }
  recoverClaim(deliveryId: string, delivered: boolean) {
    return prisma.workspacePREvent.updateMany({
      where: { deliveryId, state: delivered ? { in: ['PENDING', 'DISPATCHING'] } : 'DISPATCHING' },
      data: delivered ? { state: 'DELIVERED', deliveredAt: new Date() } : { state: 'PENDING' },
    });
  }
  cancelRecoveredDelivery(deliveryId: string, sessionId: string) {
    return prisma.workspacePREvent.updateMany({
      where: {
        deliveryId,
        deliverySessionId: sessionId,
        state: { in: ['PENDING', 'DISPATCHING'] },
      },
      data: { state: 'CANCELLED' },
    });
  }
  cancelForPR(tx: Prisma.TransactionClient, prId: string) {
    return tx.workspacePREvent.updateMany({
      where: { prId, state: 'PENDING', deliveryId: null },
      data: { state: 'CANCELLED' },
    });
  }
  cancelInTransaction(tx: Prisma.TransactionClient, workspaceId: string) {
    return tx.workspacePREvent.updateMany({
      where: { workspaceId, state: 'PENDING', deliveryId: null },
      data: { state: 'CANCELLED' },
    });
  }
  cancelWorkspace(workspaceId: string) {
    return prisma.workspacePREvent.updateMany({
      where: { workspaceId, state: 'PENDING', deliveryId: null },
      data: { state: 'CANCELLED' },
    });
  }
}
export const workspacePrEventAccessor = new WorkspacePrEventAccessor();
