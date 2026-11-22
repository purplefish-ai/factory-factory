/**
 * The PR fact ledger: every write to `WorkspacePREvent`. Facts are inserted,
 * superseded, cancelled, listed through the delivery projection, pruned and
 * slimmed here. The delivery lifecycle lives in `workspace-pr-delivery.accessor.ts`,
 * which runs the operations that change both tables in its own transaction and
 * calls the narrow transaction-client methods below for their fact half. This
 * file never imports the delivery accessor.
 */
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { prisma } from '@/backend/db';
import { isPRMonitoringRecipient, type PREventDraft } from '@/shared/pr-monitoring';
import { prMonitoringEventPayloadSchema } from '@/shared/schemas/pr-event.schema';
import { type prEventBackupSchema } from '@/shared/schemas/pr-monitoring-backup.schema';
import { type AgentSession, Prisma, type WorkspacePREvent } from '@prisma-gen/client';
import {
  readDeliveryEvents,
  projectDeliveryEvents,
  exportDeliveryEvents,
  hasState,
  carriesReviewListSql,
  filterParsedReviewListCarriers,
  scanReviewListWindow,
  withoutReviewListSql,
  PR_DELIVERY_STATE as DELIVERY,
  PR_EVENT_STATE as EVENT,
  PRUNABLE_FACT_KINDS,
} from './workspace-pr-ledger-reads.accessor';

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

/**
 * Facts that were never claimed and can never be delivered: terminal facts,
 * which the reducer, pending counts and delivery never read, and pending facts
 * of ARCHIVED workspaces. ARCHIVED is final, polling observes only READY
 * workspaces and claims require READY, so those facts have no reader either.
 * Delivery members and any legacy receipt evidence are retained, because
 * frozen batches must keep their complete membership. The `(state, createdAt)`
 * index narrows both branches by state and age, so DELIVERED history is never
 * scanned; the PENDING range still covers old pending rows of every workspace,
 * and the ARCHIVED check runs per row.
 */
function prunableTerminalEventWhere(before: Date) {
  return {
    OR: [
      { state: { in: [EVENT.SUPERSEDED, EVENT.CANCELLED] } },
      { state: EVENT.PENDING, workspace: { status: 'ARCHIVED' } },
    ],
    kind: { in: PRUNABLE_FACT_KINDS },
    prId: { not: null },
    createdAt: { lt: before },
    ...unclaimedDeliveryWhere,
  } satisfies Prisma.WorkspacePREventWhereInput;
}

const clearedDeliveryFields = {
  state: EVENT.PENDING,
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
  /**
   * The fact half of a backup restore, in the caller's transaction: check each
   * imported fact's target, then insert them verbatim. The delivery accessor's
   * `restoreBackup` checks identity collisions first and normalizes legacy
   * receipts afterwards.
   */
  async insertBackupEvents(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    events: z.infer<typeof prEventBackupSchema>[]
  ) {
    for (const event of events) {
      if (
        event.workspaceId !== workspaceId ||
        (event.prId &&
          !(await tx.workspacePR.findFirst({ where: { id: event.prId, workspaceId } })))
      ) {
        throw new Error('Imported PR event target is invalid');
      }
      validateImportedTarget(event, workspaceId);
    }
    for (const event of events) {
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
          { batchId: null, state: { in: [EVENT.PENDING, EVENT.DISPATCHING] } },
          { batch: { state: { in: [DELIVERY.PENDING, DELIVERY.DISPATCHING, DELIVERY.BLOCKED] } } },
        ],
      })
    ).filter((event) => hasState(event.state, [EVENT.PENDING, EVENT.DISPATCHING]));
  }
  /**
   * Reducer history for one PR's current observation epoch: projected PENDING,
   * DISPATCHING and DELIVERED facts. This runs inside the serialized acceptance
   * transaction, so SQL excludes old-epoch rows and unbound inactive rows (for
   * example large SUPERSEDED review payloads). Current-epoch rows bound to a
   * delivery are read regardless of their own state because the delivery's
   * state replaces theirs in the projection; the in-memory filters below
   * define the result.
   */
  async listForPR(tx: Prisma.TransactionClient, prId: string, eventEpoch: number) {
    const prefix = `${prId}:epoch:${eventEpoch}:`;
    // A BINARY-collated range equal to startsWith(prefix), served by @@unique([prId, deduplicationKey]).
    const prefixEnd = `${prefix.slice(0, -1)};`;
    const states = [EVENT.PENDING, EVENT.DISPATCHING, EVENT.DELIVERED];
    return (
      await readDeliveryEvents(tx, {
        prId,
        deduplicationKey: { gte: prefix, lt: prefixEnd },
        OR: [{ state: { in: states } }, { batchId: { not: null } }, { deliveryId: { not: null } }],
      })
    ).filter((event) => hasState(event.state, states) && event.deduplicationKey.startsWith(prefix));
  }
  /**
   * Delete one bounded batch of unclaimed SUPERSEDED/CANCELLED facts, and
   * unclaimed PENDING facts of ARCHIVED workspaces, created before `before`,
   * oldest first. The delete re-applies the predicate, so a row claimed or
   * changed after selection is kept. Returns the deleted count.
   */
  async pruneTerminalEvents(input: { before: Date; limit: number }) {
    const where = prunableTerminalEventWhere(input.before);
    const rows = await prisma.workspacePREvent.findMany({
      where,
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: input.limit,
    });
    if (!rows.length) {
      return 0;
    }
    const deleted = await prisma.workspacePREvent.deleteMany({
      where: { ...where, id: { in: rows.map((row) => row.id) } },
    });
    return deleted.count;
  }
  /**
   * The member half of pruning settled delivery units, in the delivery
   * accessor's transaction: delete the confirmed members still bound to one of
   * the confirmed units. The caller compares the count and deletes the units.
   */
  deleteDeliveryMembers(tx: Prisma.TransactionClient, memberIds: string[], unitIds: string[]) {
    return tx.workspacePREvent.deleteMany({
      where: { id: { in: memberIds }, batchId: { in: unitIds } },
    });
  }
  /**
   * Remove the PR's review list from the observation of facts written before
   * #3288, in one window of `limit` rows in ID order after `afterId`. Only
   * `observation.actionableReviews` (to `[]`) and `observation.resolvedReviewIds`
   * (removed) change; a row that does not parse as a PR fact is left alone.
   * Returns the window size, its last ID (the next cursor) and rows rewritten.
   */
  async slimReviewLists(input: { afterId: string; limit: number }) {
    const window = await scanReviewListWindow(prisma, input);
    if (!window.carrierIds.length) {
      return { scanned: window.scanned, lastId: window.lastId, slimmed: 0 };
    }
    const slimmed = await prisma.$transaction(async (tx) => {
      const ids = await filterParsedReviewListCarriers(tx, window.carrierIds);
      if (!ids.length) {
        return 0;
      }
      return Number(
        await tx.$executeRaw`UPDATE "WorkspacePREvent" SET "payload" = ${withoutReviewListSql}
          WHERE "id" IN (${Prisma.join(ids)}) AND ${carriesReviewListSql}`
      );
    });
    return { scanned: window.scanned, lastId: window.lastId, slimmed };
  }
  supersede(tx: Prisma.TransactionClient, ids: string[]) {
    return tx.workspacePREvent.updateMany({
      where: {
        id: { in: ids },
        state: EVENT.PENDING,
        ...unclaimedDeliveryWhere,
      },
      data: { state: EVENT.SUPERSEDED },
    });
  }
  /** Bind claimed facts to their delivery, in the claiming transaction. */
  bindToDelivery(tx: Prisma.TransactionClient, eventIds: string[], deliveryId: string) {
    return tx.workspacePREvent.updateMany({
      where: { id: { in: eventIds } },
      data: { batchId: deliveryId },
    });
  }
  /**
   * Bind the facts that name a legacy receipt to the delivery normalized from
   * it, clearing their receipt columns when the evidence was valid.
   */
  bindLegacyMembers(tx: Prisma.TransactionClient, deliveryId: string, clearReceipt: boolean) {
    return tx.workspacePREvent.updateMany({
      where: { deliveryId },
      data: { batchId: deliveryId, ...(clearReceipt ? clearedDeliveryFields : {}) },
    });
  }
  /** Reset the retry allowance of unclaimed facts; delivery allowances are the caller's. */
  renewUnclaimedRetryAllowance(tx: Prisma.TransactionClient, workspaceId: string) {
    return tx.workspacePREvent.updateMany({
      where: {
        workspaceId,
        state: EVENT.PENDING,
        attempts: { gte: 3 },
        ...unclaimedDeliveryWhere,
      },
      data: { attempts: 0 },
    });
  }
  /**
   * The fact half of receipt recovery after a PR was detached from a frozen
   * delivery, in the delivery accessor's transaction. Returns null when every
   * target is still attached (or the session is not a monitoring recipient);
   * otherwise cancels the members and re-creates the facts of attached PRs.
   */
  async requeueAttachedFactsAfterDetachment(
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
      where: {
        id: { in: rows.map((row) => row.id) },
        state: { in: [EVENT.PENDING, EVENT.DISPATCHING] },
      },
      data: { state: EVENT.CANCELLED },
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
  cancelForPR(tx: Prisma.TransactionClient, prId: string) {
    return tx.workspacePREvent.updateMany({
      where: {
        prId,
        state: EVENT.PENDING,
        ...unclaimedDeliveryWhere,
      },
      data: { state: EVENT.CANCELLED },
    });
  }
  /** Discard unclaimed facts that cannot be rendered, so they stop holding back later ones. */
  cancelUndeliverable(workspaceId: string, ids: string[]) {
    return prisma.workspacePREvent.updateMany({
      where: {
        id: { in: ids },
        workspaceId,
        state: EVENT.PENDING,
        ...unclaimedDeliveryWhere,
      },
      data: { state: EVENT.CANCELLED },
    });
  }
  cancelInTransaction(tx: Prisma.TransactionClient, workspaceId: string) {
    return tx.workspacePREvent.updateMany({
      where: {
        workspaceId,
        state: EVENT.PENDING,
        ...unclaimedDeliveryWhere,
      },
      data: { state: EVENT.CANCELLED },
    });
  }
  cancelWorkspace(workspaceId: string) {
    return prisma.workspacePREvent.updateMany({
      where: {
        workspaceId,
        state: EVENT.PENDING,
        ...unclaimedDeliveryWhere,
      },
      data: { state: EVENT.CANCELLED },
    });
  }
}
export const workspacePrEventAccessor = new WorkspacePrEventAccessor();
