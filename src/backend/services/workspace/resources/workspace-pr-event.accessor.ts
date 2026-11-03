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
import type {
  AgentSession,
  Prisma,
  WorkspacePRDelivery,
  WorkspacePREvent,
} from '@prisma-gen/client';
import {
  readDeliveryEvents,
  getFrozenDeliveryMembers,
  projectDeliveryEvent,
  projectDeliveryEvents,
  exportDeliveryEvents,
} from './workspace-pr-delivery.accessor';

// Frozen legacy metadata without a receipt cannot authorize another effect.
const unboundLegacyEvidenceWhere = {
  batchId: null,
  OR: [
    { deliveryId: '' },
    {
      deliveryId: null,
      OR: [
        { deliverySessionId: { not: null } },
        { deliveryProvider: { not: null } },
        { deliveryProviderSessionId: { not: null } },
        { deliveryBindingRevision: { not: null } },
        { deliveryText: { not: null } },
        { claimedAt: { not: null } },
        { deliveredAt: { not: null } },
      ],
    },
  ],
} satisfies Prisma.WorkspacePREventWhereInput;

// Positive NULL checks avoid three-valued NOT semantics on optional receipt IDs.
const unclaimedDeliveryWhere = {
  batchId: null,
  deliveryId: null,
  deliverySessionId: null,
  deliveryProvider: null,
  deliveryProviderSessionId: null,
  deliveryBindingRevision: null,
  deliveryText: null,
  claimedAt: null,
  deliveredAt: null,
} satisfies Prisma.WorkspacePREventWhereInput;

const legacyFields = [
  'workspaceId',
  'state',
  'attempts',
  'deliverySessionId',
  'deliveryProvider',
  'deliveryProviderSessionId',
  'deliveryBindingRevision',
  'deliveryText',
  'claimedAt',
  'deliveredAt',
] as const;

const clearedDeliveryFields = {
  state: 'PENDING',
  attempts: 0,
  deliveryId: null,
  deliverySessionId: null,
  deliveryProvider: null,
  deliveryProviderSessionId: null,
  deliveryBindingRevision: null,
  deliveryText: null,
  claimedAt: null,
  deliveredAt: null,
};

/** Also used for old-format restores. Invalid evidence stays verbatim on events. */
async function normalizeLegacyDelivery(tx: Prisma.TransactionClient, id: string, inert = false) {
  const existing = await tx.workspacePRDelivery.findUnique({ where: { id } });
  if (existing) {
    return existing;
  }
  const rows = await tx.workspacePREvent.findMany({
    where: { deliveryId: id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const first = rows[0];
  if (!first) {
    return null;
  }
  const valid = Boolean(
    id.length > 0 &&
    first.deliverySessionId &&
    ['CLAUDE', 'CODEX'].includes(first.deliveryProvider ?? '') &&
    first.deliveryProviderSessionId &&
    first.deliveryText &&
    Buffer.byteLength(first.deliveryText) <= 16_384 &&
    first.deliveryBindingRevision !== null &&
    first.deliveryBindingRevision >= 0 &&
    first.attempts >= 0 &&
    ['PENDING', 'DISPATCHING', 'DELIVERED', 'CANCELLED', ...(inert ? ['SUPERSEDED'] : [])].includes(
      first.state
    ) &&
    rows.every((row) =>
      legacyFields.every((field) => {
        const a = row[field],
          b = first[field];
        return a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;
      })
    )
  );
  // Imported unfinished receipts are historical evidence, never retry authority.
  // Retain raw fields before the normalizer clears them, including mixed groups.
  const held = inert && rows.some((row) => ['PENDING', 'DISPATCHING'].includes(row.state));
  const delivery = await tx.workspacePRDelivery.create({
    data: {
      id,
      workspaceId: first.workspaceId,
      eventIds: rows.map((row) => row.id),
      state: valid && !held ? first.state : 'BLOCKED',
      ...(valid
        ? {
            sessionId: first.deliverySessionId,
            provider: first.deliveryProvider,
            providerSessionId: first.deliveryProviderSessionId,
            bindingRevision: first.deliveryBindingRevision,
            text: first.deliveryText,
            attempts: first.attempts,
            claimedAt: first.claimedAt,
            deliveredAt: first.deliveredAt,
          }
        : {}),
    },
  });
  await tx.workspacePREvent.updateMany({
    where: { deliveryId: id },
    data: { batchId: id, ...(valid && !held ? clearedDeliveryFields : {}) },
  });
  return delivery;
}

async function validDeliveryMembers(tx: Prisma.TransactionClient, delivery: WorkspacePRDelivery) {
  if (delivery.state === 'BLOCKED') {
    return null;
  }
  const rows = await tx.workspacePREvent.findMany({
    where: { OR: [{ batchId: delivery.id }, { deliveryId: delivery.id }] },
  });
  const members = getFrozenDeliveryMembers(delivery, rows);
  if (!members) {
    await tx.workspacePRDelivery.update({ where: { id: delivery.id }, data: { state: 'BLOCKED' } });
    return null;
  }
  return members.map((row) => projectDeliveryEvent(row, delivery));
}

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

async function recoverAbsentIdentity(
  tx: Prisma.TransactionClient,
  deliveryId: string,
  identity: RecoveryIdentity,
  rows: WorkspacePREvent[]
): Promise<ClaimRecoveryResult | null> {
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
  if (requeued === null) {
    return null;
  }
  await tx.workspacePRDelivery.update({ where: { id: deliveryId }, data: { state: 'CANCELLED' } });
  return { count: requeued, status: 'recovered' };
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
  if (rows.length !== input.eventIds.length || new Set(input.eventIds).size !== rows.length) {
    return false;
  }
  const delivery = await normalizeLegacyDelivery(tx, input.deliveryId);
  if (!delivery) {
    return rows.every((row) => !row.deliveryId);
  }
  const members = await validDeliveryMembers(tx, delivery);
  return Boolean(
    members &&
    delivery.state === 'PENDING' &&
    delivery.sessionId === input.sessionId &&
    delivery.text === input.text &&
    members.length === rows.length &&
    members.every((member) => input.eventIds.includes(member.id)) &&
    rows.every((row) => row.deliveryId === input.deliveryId)
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
    rawEvents: z.infer<typeof prEventBackupSchema>[],
    options: { inert?: boolean } = {}
  ) {
    let heldReceipts = 0;
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
    for (const id of new Set(
      rawEvents.flatMap((event) => (event.deliveryId ? [event.deliveryId] : []))
    )) {
      if (await tx.workspacePRDelivery.findUnique({ where: { id } })) {
        throw new Error('Imported PR delivery identity already exists');
      }
      const delivery = await normalizeLegacyDelivery(tx, id, options.inert);
      heldReceipts += Number(
        options.inert &&
          delivery?.state === 'BLOCKED' &&
          rawEvents.some(
            (event) => event.deliveryId === id && ['PENDING', 'DISPATCHING'].includes(event.state)
          )
      );
    }
    // Positive NULL evidence is required: incomplete frozen facts stay held.
    const cancelled = options.inert
      ? await this.cancelInTransaction(tx, workspaceId)
      : { count: 0 };
    return { heldReceipts, cancelledFacts: cancelled.count };
  }
  projectEvents = projectDeliveryEvents;
  exportEvents = exportDeliveryEvents;
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
  async listPending(workspaceId: string, prId?: string | null) {
    return (
      await readDeliveryEvents(prisma, {
        workspaceId,
        ...(prId !== undefined ? { prId } : {}),
        OR: [
          { batchId: null, state: { in: ['PENDING', 'DISPATCHING'] } },
          { batch: { state: { in: ['PENDING', 'DISPATCHING', 'BLOCKED'] } } },
        ],
      })
    ).filter((event) => ['PENDING', 'DISPATCHING'].includes(event.state));
  }
  async listForPR(tx: Prisma.TransactionClient, prId: string) {
    return (await readDeliveryEvents(tx, { prId })).filter((event) =>
      ['PENDING', 'DISPATCHING', 'DELIVERED'].includes(event.state)
    );
  }
  supersede(tx: Prisma.TransactionClient, ids: string[]) {
    return tx.workspacePREvent.updateMany({
      where: {
        id: { in: ids },
        state: 'PENDING',
        ...unclaimedDeliveryWhere,
      },
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
      if (!(config && input.eventIds.length && input.deliveryId)) {
        return null;
      }
      // A durable claim holds the workspace until prompt completion or receipt recovery.
      const held = await tx.workspacePRDelivery.findFirst({
        where: { workspaceId: request.workspaceId, state: { in: ['DISPATCHING', 'BLOCKED'] } },
      });
      const competing =
        held ||
        (await tx.workspacePREvent.findFirst({
          where: {
            workspaceId: request.workspaceId,
            OR: [
              { batchId: null, state: 'DISPATCHING' },
              unboundLegacyEvidenceWhere,
              { batch: { state: { in: ['DISPATCHING', 'BLOCKED'] } } },
            ],
          },
        }));
      if (competing) {
        return null;
      }
      // Normalize imported legacy batches before reading their compatibility projection.
      await normalizeLegacyDelivery(tx, input.deliveryId);
      const rows = (
        await readDeliveryEvents(tx, {
          id: { in: input.eventIds },
          workspaceId: request.workspaceId,
          ...claimPRScope(request, deliveryMode),
        })
      ).filter((event) => event.state === 'PENDING');
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
      await tx.workspacePRDelivery.upsert({
        where: { id: input.deliveryId },
        create: {
          id: input.deliveryId,
          workspaceId: request.workspaceId,
          eventIds: input.eventIds,
          state: 'DISPATCHING',
          sessionId: input.sessionId,
          provider: session.provider,
          providerSessionId: session.providerSessionId,
          bindingRevision: request.bindingRevision,
          text: input.text,
          attempts: attempt,
          claimedAt: new Date(),
        },
        update: {
          state: 'DISPATCHING',
          attempts: attempt,
          bindingRevision: request.bindingRevision,
          claimedAt: new Date(),
        },
      });
      await tx.workspacePREvent.updateMany({
        where: { id: { in: input.eventIds } },
        data: { batchId: input.deliveryId },
      });
      return { ...input, ...identity, bindingRevision: request.bindingRevision, attempt };
    });
  }
  settleDelivery(input: {
    deliveryId: string;
    sessionId: string;
    bindingRevision: number;
    attempt?: number;
    result: 'delivered' | 'retry' | 'failed';
  }) {
    return prisma.$transaction(async (tx) => {
      const delivery = await normalizeLegacyDelivery(tx, input.deliveryId);
      if (!(delivery && (await validDeliveryMembers(tx, delivery)))) {
        return false;
      }
      const result = await tx.workspacePRDelivery.updateMany({
        where: {
          id: input.deliveryId,
          sessionId: input.sessionId,
          bindingRevision: input.bindingRevision,
          state: 'DISPATCHING',
          ...(input.attempt !== undefined && { attempts: input.attempt }),
        },
        data:
          input.result === 'delivered'
            ? { state: 'DELIVERED', deliveredAt: new Date() }
            : { state: 'PENDING' },
      });
      return result.count > 0;
    });
  }
  deferBusy(deliveryId: string) {
    return prisma.$transaction(async (tx) => {
      const delivery = await normalizeLegacyDelivery(tx, deliveryId);
      if (!(delivery && (await validDeliveryMembers(tx, delivery)))) {
        return { count: 0 };
      }
      return tx.workspacePRDelivery.updateMany({
        where: { id: deliveryId, state: 'DISPATCHING', attempts: { gt: 0 } },
        data: { state: 'PENDING', attempts: { decrement: 1 } },
      });
    });
  }
  async renewRetryAllowance(tx: Prisma.TransactionClient, workspaceId: string) {
    const legacy = await tx.workspacePREvent.findMany({
      where: { workspaceId, deliveryId: { not: null } },
      select: { deliveryId: true },
    });
    for (const id of new Set(legacy.flatMap((row) => (row.deliveryId ? [row.deliveryId] : [])))) {
      await normalizeLegacyDelivery(tx, id);
    }
    const deliveries = await tx.workspacePRDelivery.findMany({
      where: { workspaceId, state: { in: ['PENDING', 'DISPATCHING'] }, attempts: { gte: 3 } },
    });
    for (const delivery of deliveries) {
      if (await validDeliveryMembers(tx, delivery)) {
        await tx.workspacePRDelivery.update({ where: { id: delivery.id }, data: { attempts: 0 } });
      }
    }
    return tx.workspacePREvent.updateMany({
      where: {
        workspaceId,
        state: 'PENDING',
        attempts: { gte: 3 },
        ...unclaimedDeliveryWhere,
      },
      data: { attempts: 0 },
    });
  }
  recoverClaim(
    deliveryId: string,
    delivered: boolean,
    identity?: RecoveryIdentity
  ): Promise<ClaimRecoveryResult> {
    return prisma.$transaction(async (tx) => {
      const delivery = await normalizeLegacyDelivery(tx, deliveryId);
      if (!delivery) {
        return { count: 0, status: 'settled' };
      }
      const rows = await validDeliveryMembers(tx, delivery);
      if (!rows) {
        return { count: 0, status: 'identity_mismatch' };
      }
      if (!['PENDING', 'DISPATCHING'].includes(delivery.state)) {
        return { count: 0, status: 'settled' };
      }
      if (!delivered && identity) {
        const recovered = await recoverAbsentIdentity(tx, deliveryId, identity, rows);
        if (recovered) {
          return recovered;
        }
      }
      await tx.workspacePRDelivery.update({
        where: { id: deliveryId },
        data: delivered
          ? { state: 'DELIVERED', deliveredAt: new Date() }
          : {
              state: 'PENDING',
              ...(identity && { providerSessionId: identity.providerSessionId }),
            },
      });
      return { count: rows.length, status: 'recovered' };
    });
  }
  cancelRecoveredDelivery(deliveryId: string, sessionId: string) {
    return prisma.$transaction(async (tx) => {
      const delivery = await normalizeLegacyDelivery(tx, deliveryId);
      if (!(delivery && (await validDeliveryMembers(tx, delivery)))) {
        return { count: 0 };
      }
      return tx.workspacePRDelivery.updateMany({
        where: { id: deliveryId, sessionId, state: { in: ['PENDING', 'DISPATCHING'] } },
        data: { state: 'CANCELLED' },
      });
    });
  }
  cancelForPR(tx: Prisma.TransactionClient, prId: string) {
    return tx.workspacePREvent.updateMany({
      where: {
        prId,
        state: 'PENDING',
        ...unclaimedDeliveryWhere,
      },
      data: { state: 'CANCELLED' },
    });
  }
  cancelUnclaimedControls(tx: Prisma.TransactionClient, workspaceId: string) {
    return tx.workspacePREvent.updateMany({
      where: {
        workspaceId,
        kind: 'MONITORING_ENABLED',
        ...unclaimedDeliveryWhere,
        state: 'PENDING',
      },
      data: { state: 'CANCELLED' },
    });
  }
  cancelInTransaction(tx: Prisma.TransactionClient, workspaceId: string) {
    return tx.workspacePREvent.updateMany({
      where: {
        workspaceId,
        state: 'PENDING',
        ...unclaimedDeliveryWhere,
      },
      data: { state: 'CANCELLED' },
    });
  }
  cancelWorkspace(workspaceId: string) {
    return prisma.workspacePREvent.updateMany({
      where: {
        workspaceId,
        state: 'PENDING',
        ...unclaimedDeliveryWhere,
      },
      data: { state: 'CANCELLED' },
    });
  }
}
export const workspacePrEventAccessor = new WorkspacePrEventAccessor();
