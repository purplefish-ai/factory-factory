/**
 * The frozen delivery lifecycle: every write to `WorkspacePRDelivery`. Claim,
 * settle, defer, recover, cancel, discard and retry allowance; normalization
 * of legacy receipt columns into delivery rows; backup restore; and retention
 * of whole delivery units. An operation that also changes facts opens its
 * transaction here and calls a narrow transaction-client method of
 * `workspace-pr-event.accessor.ts`, which owns every `WorkspacePREvent` write
 * and never imports this file. Backup restore lives here for that reason: an
 * old-format backup's receipts become delivery rows in the restoring
 * transaction.
 */
import { z } from 'zod';
import { prisma } from '@/backend/db';
import {
  isPRMonitoringRecipient,
  PR_DEDICATED_WORKFLOW,
  prDeliveryModeSchema,
  type ClaimedPRDelivery,
  type PRDeliveryRequest,
} from '@/shared/pr-monitoring';
import { prEventBackupSchema } from '@/shared/schemas/pr-monitoring-backup.schema';
import type {
  AgentSession,
  Prisma,
  WorkspacePRDelivery,
  WorkspacePREvent,
} from '@prisma-gen/client';
import { backupCollisionsAccessor } from './backup-collisions.accessor';
import { workspacePrEventAccessor } from './workspace-pr-event.accessor';
import {
  readDeliveryEvents,
  getFrozenDeliveryMembers,
  projectDeliveryEvent,
  hasState,
  isQuarantinedDeliveryState,
  parseDeliveryState,
  confirmPrunableDeliveryUnits,
  findPrunableDeliveryIds,
  PR_DELIVERY_STATE as DELIVERY,
  PR_EVENT_STATE as EVENT,
  PRUNABLE_DELIVERY_STATES,
} from './workspace-pr-ledger-reads';

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

/** Delivery states that do not hold a workspace's claim; every other value does. */
const nonHoldingDeliveryStates = [
  DELIVERY.PENDING,
  DELIVERY.DELIVERED,
  DELIVERY.SUPERSEDED,
  DELIVERY.CANCELLED,
  DELIVERY.DISMISSED,
];

/**
 * Delete whole settled delivery units, members before their delivery, in the
 * caller's transaction, after confirming each unit again. A delete count that
 * differs from the confirmed units throws, so the transaction rolls back
 * rather than split a delivery from its members.
 */
async function deletePrunableDeliveries(tx: Prisma.TransactionClient, ids: string[], before: Date) {
  const units = await confirmPrunableDeliveryUnits(tx, ids, before);
  const unitIds = units.map((unit) => unit.id);
  const memberIds = units.flatMap((unit) => unit.memberIds);
  if (!unitIds.length) {
    return { deliveries: 0, events: 0 };
  }
  const events = await workspacePrEventAccessor.deleteDeliveryMembers(tx, memberIds, unitIds);
  const removed = await tx.workspacePRDelivery.deleteMany({
    where: { id: { in: unitIds }, state: { in: PRUNABLE_DELIVERY_STATES } },
  });
  if (events.count !== memberIds.length || removed.count !== unitIds.length) {
    throw new Error('PR delivery retention would split a delivery from its members');
  }
  return { deliveries: removed.count, events: events.count };
}

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
    hasState(first.state, [
      EVENT.PENDING,
      EVENT.DISPATCHING,
      EVENT.DELIVERED,
      EVENT.CANCELLED,
      ...(inert ? [EVENT.SUPERSEDED] : []),
    ]) &&
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
  const held = inert && rows.some((row) => hasState(row.state, [EVENT.PENDING, EVENT.DISPATCHING]));
  const delivery = await tx.workspacePRDelivery.create({
    data: {
      id,
      workspaceId: first.workspaceId,
      eventIds: rows.map((row) => row.id),
      state: valid && !held ? first.state : DELIVERY.BLOCKED,
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
  await workspacePrEventAccessor.bindLegacyMembers(tx, id, valid && !held);
  return delivery;
}

async function validDeliveryMembers(tx: Prisma.TransactionClient, delivery: WorkspacePRDelivery) {
  if (isQuarantinedDeliveryState(parseDeliveryState(delivery))) {
    return null;
  }
  const rows = await tx.workspacePREvent.findMany({
    where: { OR: [{ batchId: delivery.id }, { deliveryId: delivery.id }] },
  });
  const members = getFrozenDeliveryMembers(delivery, rows);
  if (!members) {
    await tx.workspacePRDelivery.update({
      where: { id: delivery.id },
      data: { state: DELIVERY.BLOCKED },
    });
    return null;
  }
  return members.map((row) => projectDeliveryEvent(row, delivery));
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
  const requeued = await workspacePrEventAccessor.requeueAttachedFactsAfterDetachment(
    tx,
    session,
    rows
  );
  if (requeued === null) {
    return null;
  }
  await tx.workspacePRDelivery.update({
    where: { id: deliveryId },
    data: { state: DELIVERY.CANCELLED },
  });
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
    delivery.state === DELIVERY.PENDING &&
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

class WorkspacePrDeliveryAccessor {
  async restoreBackup(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    rawEvents: z.infer<typeof prEventBackupSchema>[],
    options: { inert?: boolean } = {}
  ) {
    const events = rawEvents.map((raw) => prEventBackupSchema.parse(raw));
    if ((await backupCollisionsAccessor.findEventConflicts(tx, events)).size) {
      throw new Error('Imported PR event or delivery identity already exists');
    }
    let heldReceipts = 0;
    await workspacePrEventAccessor.insertBackupEvents(tx, workspaceId, events);
    for (const id of new Set(
      rawEvents.flatMap((event) => (event.deliveryId ? [event.deliveryId] : []))
    )) {
      const delivery = await normalizeLegacyDelivery(tx, id, options.inert);
      heldReceipts += Number(
        options.inert &&
          delivery?.state === DELIVERY.BLOCKED &&
          rawEvents.some(
            (event) =>
              event.deliveryId === id && hasState(event.state, [EVENT.PENDING, EVENT.DISPATCHING])
          )
      );
    }
    // Positive NULL evidence is required: incomplete frozen facts stay held.
    const cancelled = options.inert
      ? await workspacePrEventAccessor.cancelInTransaction(tx, workspaceId)
      : { count: 0 };
    return { heldReceipts, cancelledFacts: cancelled.count };
  }
  /**
   * Delete one bounded batch of settled delivery units that no reader needs:
   * DELIVERED, CANCELLED or SUPERSEDED deliveries settled before `before`
   * whose every member is an old PR fact without legacy evidence, of an
   * ARCHIVED workspace or of an earlier event epoch than its workspace's
   * current one (see `prunableDeliveryUnitSql`). A delivery and all of its
   * members go in one transaction or not at all. Deliveries are visited in ID
   * order after `afterId`; pass `lastId` back to continue.
   */
  async pruneSettledDeliveries(input: { before: Date; afterId: string; limit: number }) {
    const ids = await findPrunableDeliveryIds(prisma, input);
    const lastId = ids.at(-1) ?? null;
    if (!lastId) {
      return { selected: 0, lastId, deliveries: 0, events: 0 };
    }
    const deleted = await prisma.$transaction((tx) =>
      deletePrunableDeliveries(tx, ids, input.before)
    );
    return { selected: ids.length, lastId, ...deleted };
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
      // Any state not known to be idle or settled holds it, so unknown values fail closed.
      const held = await tx.workspacePRDelivery.findFirst({
        where: { workspaceId: request.workspaceId, state: { notIn: nonHoldingDeliveryStates } },
      });
      const competing =
        held ||
        (await tx.workspacePREvent.findFirst({
          where: {
            workspaceId: request.workspaceId,
            OR: [
              { batchId: null, state: EVENT.DISPATCHING },
              unboundLegacyEvidenceWhere,
              { batch: { state: { notIn: nonHoldingDeliveryStates } } },
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
      ).filter((event) => event.state === EVENT.PENDING);
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
          state: DELIVERY.DISPATCHING,
          sessionId: input.sessionId,
          provider: session.provider,
          providerSessionId: session.providerSessionId,
          bindingRevision: request.bindingRevision,
          text: input.text,
          attempts: attempt,
          claimedAt: new Date(),
        },
        update: {
          state: DELIVERY.DISPATCHING,
          attempts: attempt,
          bindingRevision: request.bindingRevision,
          claimedAt: new Date(),
        },
      });
      await workspacePrEventAccessor.bindToDelivery(tx, input.eventIds, input.deliveryId);
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
          state: DELIVERY.DISPATCHING,
          ...(input.attempt !== undefined && { attempts: input.attempt }),
        },
        data:
          input.result === 'delivered'
            ? { state: DELIVERY.DELIVERED, deliveredAt: new Date() }
            : { state: DELIVERY.PENDING },
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
        where: { id: deliveryId, state: DELIVERY.DISPATCHING, attempts: { gt: 0 } },
        data: { state: DELIVERY.PENDING, attempts: { decrement: 1 } },
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
      where: {
        workspaceId,
        state: { in: [DELIVERY.PENDING, DELIVERY.DISPATCHING] },
        attempts: { gte: 3 },
      },
    });
    for (const delivery of deliveries) {
      if (await validDeliveryMembers(tx, delivery)) {
        await tx.workspacePRDelivery.update({ where: { id: delivery.id }, data: { attempts: 0 } });
      }
    }
    return workspacePrEventAccessor.renewUnclaimedRetryAllowance(tx, workspaceId);
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
      if (!hasState(parseDeliveryState(delivery), [DELIVERY.PENDING, DELIVERY.DISPATCHING])) {
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
          ? { state: DELIVERY.DELIVERED, deliveredAt: new Date() }
          : {
              state: DELIVERY.PENDING,
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
        where: {
          id: deliveryId,
          sessionId,
          state: { in: [DELIVERY.PENDING, DELIVERY.DISPATCHING] },
        },
        data: { state: DELIVERY.CANCELLED },
      });
    });
  }
  /**
   * Explicit user discard of a workspace's quarantined deliveries. Delivery rows,
   * membership and event evidence stay verbatim; members read as CANCELLED and
   * later facts can be claimed again. Nothing is resent: blocked evidence never
   * proves absence. Dismissal is local and is not carried by backups.
   */
  discardBlockedDeliveries(workspaceId: string) {
    return prisma.workspacePRDelivery.updateMany({
      where: { workspaceId, state: DELIVERY.BLOCKED },
      data: { state: DELIVERY.DISMISSED },
    });
  }
}
export const workspacePrDeliveryAccessor = new WorkspacePrDeliveryAccessor();
