import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@/backend/db';
import {
  isPRMonitoringRecipient,
  PR_DEDICATED_WORKFLOW,
  prDeliveryModeSchema,
  type ClaimedPRDelivery,
  type PRDeliveryRequest,
  type PREventDraft,
} from '@/shared/pr-monitoring';
import { prMonitoringEventPayloadSchema } from '@/shared/schemas/pr-event.schema';
import { prEventBackupSchema } from '@/shared/schemas/pr-monitoring-backup.schema';
import type { AgentSession, Prisma, WorkspacePREvent } from '@prisma-gen/client';

function validateImportedTarget(event: z.infer<typeof prEventBackupSchema>, workspaceId: string) {
  if (
    event.payload.kind === 'MONITORING_ENABLED'
      ? event.payload.workspaceId !== workspaceId || event.prId !== null
      : event.payload.target.workspaceId !== workspaceId || event.payload.target.prId !== event.prId
  ) {
    throw new Error('Imported event payload target is invalid');
  }
}
async function authorizedRecipient(
  tx: Prisma.TransactionClient,
  request: PRDeliveryRequest,
  session: AgentSession,
  mainRecipientId: string | null
): Promise<boolean> {
  if (
    request.prId &&
    !(await tx.workspacePR.findFirst({
      where: { id: request.prId, workspaceId: request.workspaceId, detachedAt: null },
    }))
  ) {
    return false;
  }
  if ((request.deliveryMode ?? 'MAIN') === 'MAIN') {
    return session.id === mainRecipientId && isPRMonitoringRecipient(session);
  }
  if (
    !request.prId ||
    session.workflow !== PR_DEDICATED_WORKFLOW ||
    session.workspacePrId !== request.prId
  ) {
    return false;
  }
  return Boolean(
    await tx.workspacePRDedicatedSession.findFirst({
      where: {
        prId: request.prId,
        sessionId: session.id,
        pr: { workspaceId: request.workspaceId, detachedAt: null },
      },
    })
  );
}

type RecoveryIdentity = {
  sessionId: string;
  provider: AgentSession['provider'];
  providerSessionId: string;
};

type ClaimRecoveryResult = {
  count: number;
  status: 'recovered' | 'settled' | 'identity_mismatch';
};

function hasRolloverLineage(session: AgentSession, previousIdentity: string | null) {
  if (!(previousIdentity && session.providerSessionId)) {
    return false;
  }
  if (previousIdentity === session.providerSessionId) {
    return true;
  }
  const metadata = z
    .object({
      providerIdentityRollovers: z.array(
        z.object({
          previousProviderSessionId: z.string().min(1),
          providerSessionId: z.string().min(1),
        })
      ),
    })
    .safeParse(session.providerMetadata);
  if (!metadata.success) {
    return false;
  }
  const reachable = new Set([previousIdentity]);
  for (const rollover of metadata.data.providerIdentityRollovers) {
    if (reachable.has(rollover.previousProviderSessionId)) {
      reachable.add(rollover.providerSessionId);
    }
  }
  return reachable.has(session.providerSessionId);
}

async function requeueAttachedFactsAfterDetachment(
  tx: Prisma.TransactionClient,
  session: AgentSession,
  rows: WorkspacePREvent[]
): Promise<number | null> {
  const targetIds = [...new Set(rows.flatMap((row) => (row.prId ? [row.prId] : [])))];
  if (!(isPRMonitoringRecipient(session) && targetIds.length)) {
    return null;
  }
  const attached = await tx.workspacePR.findMany({
    where: { id: { in: targetIds }, workspaceId: session.workspaceId, detachedAt: null },
    select: { id: true },
  });
  if (attached.length === targetIds.length) {
    return null;
  }
  const attachedIds = new Set(attached.map((pr) => pr.id));
  const cancelled = await tx.workspacePREvent.updateMany({
    where: { id: { in: rows.map((row) => row.id) }, state: { in: ['PENDING', 'DISPATCHING'] } },
    data: { state: 'CANCELLED' },
  });
  for (const row of rows) {
    if (!(row.prId && attachedIds.has(row.prId))) {
      continue;
    }
    // Keep the frozen delivery and receipt evidence intact. Transfer its
    // canonical reducer key to a fresh row only after receipt proves absence.
    await tx.workspacePREvent.update({
      where: { id: row.id },
      data: { deduplicationKey: `recovered:${row.id}:${randomUUID()}` },
    });
    await tx.workspacePREvent.create({
      data: {
        workspaceId: row.workspaceId,
        prId: row.prId,
        kind: row.kind,
        deduplicationKey: row.deduplicationKey,
        payload: prMonitoringEventPayloadSchema.parse(row.payload),
        createdAt: row.createdAt,
      },
    });
  }
  return cancelled.count;
}

type DeliveryClaimInput = Omit<ClaimedPRDelivery, 'bindingRevision' | 'attempt'>;
function claimPRScope(request: PRDeliveryRequest, deliveryMode: 'MAIN' | 'DEDICATED') {
  return deliveryMode === 'MAIN' && request.prId === null ? {} : { prId: request.prId };
}

async function matchesFrozenClaim(
  tx: Prisma.TransactionClient,
  input: DeliveryClaimInput,
  rows: WorkspacePREvent[]
) {
  if (rows.length !== input.eventIds.length) {
    return false;
  }
  if (
    rows.some(
      (row) =>
        row.deliveryId &&
        (row.deliveryId !== input.deliveryId ||
          row.deliverySessionId !== input.sessionId ||
          row.deliveryText !== input.text)
    )
  ) {
    return false;
  }
  if (!rows.some((row) => row.deliveryId)) {
    return true;
  }
  // Frozen retries contain every original event and no newly observed facts.
  return (
    rows.every((row) => row.deliveryId === input.deliveryId) &&
    (await tx.workspacePREvent.count({ where: { deliveryId: input.deliveryId } })) === rows.length
  );
}
async function claimTargetsAttached(
  tx: Prisma.TransactionClient,
  request: PRDeliveryRequest,
  rows: WorkspacePREvent[]
) {
  const legacyControls =
    request.prId === null &&
    rows.every((row) => row.prId === null && row.kind === 'MONITORING_ENABLED');
  if (legacyControls) {
    return true;
  }
  const targetIds = [...new Set(rows.map((row) => row.prId))];
  if (targetIds.some((id) => !id)) {
    return false;
  }
  return (
    (await tx.workspacePR.count({
      where: {
        id: { in: targetIds.filter((id): id is string => id !== null) },
        workspaceId: request.workspaceId,
        detachedAt: null,
      },
    })) === targetIds.length
  );
}
function matchesClaimIdentity(
  session: AgentSession | null,
  rows: WorkspacePREvent[]
): session is AgentSession & { providerSessionId: string } {
  if (!session?.providerSessionId) {
    return false;
  }
  return rows.every(
    (row) =>
      !row.deliveryId ||
      Boolean(
        row.deliveryProviderSessionId &&
        row.deliveryProvider === session.provider &&
        row.deliveryProviderSessionId === session.providerSessionId
      )
  );
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
        where: {
          workspaceId,
          bindingRevision,
          enabled: true,
          deliveryMode: 'MAIN',
          recipientSessionId: { not: null },
        },
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
    input: DeliveryClaimInput
  ): Promise<ClaimedPRDelivery | null> {
    const deliveryMode = prDeliveryModeSchema.parse(request.deliveryMode ?? 'MAIN');
    return prisma.$transaction(async (tx) => {
      const config = await tx.workspacePRMonitoring.findFirst({
        where: {
          workspaceId: request.workspaceId,
          enabled: true,
          deliveryMode,
          bindingRevision: request.bindingRevision,
          deliveryPauseReason: null,
          workspace: { status: 'READY' },
        },
      });
      if (!(config && input.eventIds.length)) {
        return null;
      }
      // A durable claim holds the workspace until prompt completion or receipt recovery.
      const competing = await tx.workspacePREvent.findFirst({
        where: {
          workspaceId: request.workspaceId,
          state: 'DISPATCHING',
          OR: [{ deliveryId: null }, { deliveryId: { not: input.deliveryId } }],
        },
      });
      if (competing) {
        return null;
      }
      const rows = await tx.workspacePREvent.findMany({
        where: {
          id: { in: input.eventIds },
          workspaceId: request.workspaceId,
          ...claimPRScope(request, deliveryMode),
          state: 'PENDING',
        },
      });
      if (!(await matchesFrozenClaim(tx, input, rows))) {
        return null;
      }
      if (!(await claimTargetsAttached(tx, request, rows))) {
        return null;
      }
      const session = await tx.agentSession.findFirst({
        where: { id: input.sessionId, workspaceId: request.workspaceId },
      });
      if (!matchesClaimIdentity(session, rows)) {
        return null;
      }
      if (!(await authorizedRecipient(tx, request, session, config.recipientSessionId))) {
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
  async recoverClaim(
    deliveryId: string,
    delivered: boolean,
    identity?: RecoveryIdentity
  ): Promise<ClaimRecoveryResult> {
    if (!delivered && identity) {
      // Only receipt recovery may migrate a frozen claim to a recorded successor.
      return prisma.$transaction(async (tx) => {
        const rows = await tx.workspacePREvent.findMany({
          where: { deliveryId, state: { in: ['PENDING', 'DISPATCHING'] } },
        });
        if (!rows.length) {
          return { count: 0, status: 'settled' };
        }
        const session = await tx.agentSession.findFirst({
          where: {
            id: identity.sessionId,
            provider: identity.provider,
            providerSessionId: identity.providerSessionId,
          },
        });
        if (
          !session ||
          rows.some(
            (row) =>
              row.workspaceId !== session.workspaceId ||
              row.deliverySessionId !== session.id ||
              row.deliveryProvider !== session.provider ||
              !hasRolloverLineage(session, row.deliveryProviderSessionId)
          )
        ) {
          return { count: 0, status: 'identity_mismatch' };
        }
        const requeued = await requeueAttachedFactsAfterDetachment(tx, session, rows);
        if (requeued !== null) {
          return { count: requeued, status: 'recovered' };
        }
        const updated = await tx.workspacePREvent.updateMany({
          where: {
            id: { in: rows.map((row) => row.id) },
            state: { in: ['PENDING', 'DISPATCHING'] },
          },
          data: { state: 'PENDING', deliveryProviderSessionId: identity.providerSessionId },
        });
        return { ...updated, status: updated.count ? 'recovered' : 'settled' };
      });
    }
    const updated = await prisma.workspacePREvent.updateMany({
      where: { deliveryId, state: delivered ? { in: ['PENDING', 'DISPATCHING'] } : 'DISPATCHING' },
      data: delivered ? { state: 'DELIVERED', deliveredAt: new Date() } : { state: 'PENDING' },
    });
    return { ...updated, status: updated.count ? 'recovered' : 'settled' };
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
  cancelUnclaimedControls(tx: Prisma.TransactionClient, workspaceId: string) {
    return tx.workspacePREvent.updateMany({
      where: { workspaceId, kind: 'MONITORING_ENABLED', state: 'PENDING', deliveryId: null },
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
