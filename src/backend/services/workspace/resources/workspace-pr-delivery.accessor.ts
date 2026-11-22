import { z } from 'zod';
import {
  type PRDeliveryState,
  prDeliveryStateSchema,
  prEventStateSchema,
  prFactPayloadSchema,
} from '@/shared/schemas/pr-event.schema';
import { Prisma, type WorkspacePRDelivery, type WorkspacePREvent } from '@prisma-gen/client';

export const PR_DELIVERY_STATE = prDeliveryStateSchema.enum;
export const PR_EVENT_STATE = prEventStateSchema.enum;

/** Quarantined evidence: never projected onto members, settled, retried or flattened. */
export function isQuarantinedDeliveryState(state: PRDeliveryState): boolean {
  return state === PR_DELIVERY_STATE.BLOCKED || state === PR_DELIVERY_STATE.DISMISSED;
}

/** Typed membership test for a persisted (string) state column. */
export function hasState<T extends string>(state: string, states: readonly T[]): state is T {
  return (states as readonly string[]).includes(state);
}

/** Parse persisted delivery state; an unknown value fails closed instead of reading as live. */
export function parseDeliveryState(delivery: Pick<WorkspacePRDelivery, 'state'>): PRDeliveryState {
  return prDeliveryStateSchema.parse(delivery.state);
}

const prDeliveryMembershipSchema = z.array(z.string().min(1)).min(1);
type DeliveryMemberIdentity = Pick<
  WorkspacePREvent,
  'id' | 'workspaceId' | 'batchId' | 'deliveryId'
>;
/** Validate the complete explicit membership before export or any lifecycle transition. */
export function getFrozenDeliveryMembers<T extends DeliveryMemberIdentity>(
  delivery: Pick<WorkspacePRDelivery, 'id' | 'workspaceId' | 'eventIds'>,
  events: T[]
): T[] | null {
  const parsed = prDeliveryMembershipSchema.safeParse(delivery.eventIds);
  if (!parsed.success) {
    return null;
  }
  const ids = new Set(parsed.data);
  const members = events.filter(
    (event) => event.batchId === delivery.id || event.deliveryId === delivery.id
  );
  if (
    ids.size !== parsed.data.length ||
    members.length !== ids.size ||
    members.some(
      (event) =>
        !ids.has(event.id) ||
        event.workspaceId !== delivery.workspaceId ||
        event.batchId !== delivery.id
    )
  ) {
    return null;
  }
  return members;
}

export function projectDeliveryEvent(
  event: WorkspacePREvent,
  delivery?: WorkspacePRDelivery
): WorkspacePREvent {
  prEventStateSchema.parse(event.state);
  if (!delivery) {
    return event;
  }
  const state = parseDeliveryState(delivery);
  // Blocked evidence keeps holding the workspace; dismissed evidence is retained
  // verbatim but is no longer live, so neither overlays its frozen fields. A
  // dismissed member keeps settled raw states (a DELIVERED fact stays delivered
  // history); only its unsettled PENDING/DISPATCHING state reads as CANCELLED.
  if (state === PR_DELIVERY_STATE.BLOCKED) {
    return { ...event, state: PR_EVENT_STATE.DISPATCHING };
  }
  if (state === PR_DELIVERY_STATE.DISMISSED) {
    return hasState(event.state, [PR_EVENT_STATE.PENDING, PR_EVENT_STATE.DISPATCHING])
      ? { ...event, state: PR_EVENT_STATE.CANCELLED }
      : event;
  }
  return {
    ...event,
    deliveryId: delivery.id,
    state,
    attempts: delivery.attempts,
    deliverySessionId: delivery.sessionId,
    deliveryProvider: delivery.provider,
    deliveryProviderSessionId: delivery.providerSessionId,
    deliveryBindingRevision: delivery.bindingRevision,
    deliveryText: delivery.text,
    claimedAt: delivery.claimedAt,
    deliveredAt: delivery.deliveredAt,
  };
}

export function projectDeliveryEvents(
  events: WorkspacePREvent[],
  deliveries: WorkspacePRDelivery[]
) {
  const byId = new Map(deliveries.map((delivery) => [delivery.id, delivery]));
  return events.map((event) => {
    const id = event.batchId ?? event.deliveryId;
    return projectDeliveryEvent(event, id === null ? undefined : byId.get(id));
  });
}

export async function readDeliveryEvents(
  tx: Prisma.TransactionClient,
  where: Prisma.WorkspacePREventWhereInput
) {
  const events = await tx.workspacePREvent.findMany({
    where,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const ids = [
    ...new Set(
      events.flatMap((event) => {
        const id = event.batchId ?? event.deliveryId;
        return id === null ? [] : [id];
      })
    ),
  ];
  const deliveries = ids.length
    ? await tx.workspacePRDelivery.findMany({ where: { id: { in: ids } } })
    : [];
  return projectDeliveryEvents(events, deliveries);
}

/** Keep the old backup shape lossless; a partial normalized batch cannot be exported. */
export function exportDeliveryEvents(
  events: WorkspacePREvent[],
  deliveries: WorkspacePRDelivery[]
) {
  for (const delivery of deliveries) {
    const members = getFrozenDeliveryMembers(delivery, events);
    if (!members) {
      throw new Error('Cannot export incomplete PR delivery membership');
    }
    if (
      isQuarantinedDeliveryState(parseDeliveryState(delivery)) &&
      members.some((event) => event.deliveryId !== delivery.id)
    ) {
      throw new Error('Cannot flatten blocked normalized PR delivery evidence');
    }
  }
  const byId = new Map(deliveries.map((delivery) => [delivery.id, delivery]));
  // Quarantined evidence exports verbatim; a dismissal is local and is not exported.
  return events.map((event) => {
    const delivery = byId.get(event.batchId ?? event.deliveryId ?? '');
    return delivery && isQuarantinedDeliveryState(parseDeliveryState(delivery))
      ? event
      : projectDeliveryEvent(event, delivery);
  });
}

/**
 * Every fact kind: each deduplication identity embeds the PR's transition
 * sequence, which is persisted with each accepted observation and only grows,
 * so the reducer can never regenerate a pruned key. Legacy `MONITORING_ENABLED`
 * controls are never pruned.
 */
export const PRUNABLE_FACT_KINDS = [
  'REVIEW_FEEDBACK',
  'CI_FAILED',
  'CI_RECOVERED',
  'CONFLICT_DETECTED',
  'CONFLICT_CLEARED',
  'PR_MERGED',
  'PR_CLOSED',
];

/**
 * Settled delivery states whose whole unit retention may delete. Live states,
 * quarantined BLOCKED and DISMISSED evidence, and any unknown value never qualify.
 */
export const PRUNABLE_DELIVERY_STATES = [
  PR_DELIVERY_STATE.DELIVERED,
  PR_DELIVERY_STATE.CANCELLED,
  PR_DELIVERY_STATE.SUPERSEDED,
];

/**
 * Member `m` carries a `<prId>:epoch:<n>:` key with a decimal `n` below its
 * workspace's current epoch (`mo`). `listForPR` reads only the current epoch's
 * prefix, and the epoch never decreases, so no reducer reads the row again.
 */
function oldEpochMemberSql() {
  const rest = Prisma.sql`substr(m."deduplicationKey", length(m."prId") + 8)`;
  const epoch = Prisma.sql`substr(${rest}, 1, instr(${rest}, ':') - 1)`;
  return Prisma.sql`(substr(m."deduplicationKey", 1, length(m."prId") + 7) = m."prId" || ':epoch:'
    AND instr(${rest}, ':') > 1
    AND ${epoch} NOT GLOB '*[^0-9]*'
    AND CAST(${epoch} AS INTEGER) < mo."eventEpoch")`;
}

/**
 * Member `m` of delivery `d` (workspace `w`, monitoring `mo`) that no reader
 * needs: an old, ordinary PR fact without legacy receipt evidence, of an
 * ARCHIVED workspace or of an earlier epoch. Key columns come first, so a
 * current-epoch member is rejected without reading its payload.
 */
function unreadMemberSql(before: Date) {
  return Prisma.sql`(m."workspaceId" = d."workspaceId"
    AND m."prId" IS NOT NULL
    AND m."kind" IN (${Prisma.join(PRUNABLE_FACT_KINDS)})
    AND (w."status" = 'ARCHIVED' OR ${oldEpochMemberSql()})
    AND m."deliveryId" IS NULL
    AND m."deliverySessionId" IS NULL
    AND m."deliveryProvider" IS NULL
    AND m."deliveryProviderSessionId" IS NULL
    AND m."deliveryBindingRevision" IS NULL
    AND m."deliveryText" IS NULL
    AND m."claimedAt" IS NULL
    AND m."deliveredAt" IS NULL
    AND m."createdAt" < ${before})`;
}

/**
 * Delivery `d` (joined to workspace `w` and, left, monitoring `mo`) is a
 * settled, complete unit whose every member is unread. Membership must be what
 * `getFrozenDeliveryMembers` accepts: a non-empty array of distinct non-empty
 * IDs, each a row bound by `batchId`, no other bound row, and no legacy row
 * naming the delivery by `deliveryId`. Every term is NULL-safe: an unknown or
 * unparseable value keeps the delivery.
 */
function prunableDeliveryUnitSql(before: Date) {
  const ids = Prisma.sql`(CASE WHEN json_valid(d."eventIds") THEN
    CASE WHEN json_type(d."eventIds") = 'array' THEN d."eventIds" END END)`;
  return Prisma.sql`(d."state" IN (${Prisma.join(PRUNABLE_DELIVERY_STATES)})
    AND (d."claimedAt" IS NULL OR d."claimedAt" < ${before})
    AND (d."deliveredAt" IS NULL OR d."deliveredAt" < ${before})
    AND json_array_length(${ids}) > 0
    AND json_array_length(${ids}) =
      (SELECT count(*) FROM "WorkspacePREvent" b WHERE b."batchId" = d."id")
    AND NOT EXISTS (SELECT 1 FROM json_each(${ids}) j
      WHERE j."type" <> 'text' OR j."value" = '' OR NOT EXISTS
        (SELECT 1 FROM "WorkspacePREvent" e WHERE e."id" = j."value" AND e."batchId" = d."id"))
    AND NOT EXISTS (SELECT 1 FROM "WorkspacePREvent" m WHERE m."batchId" = d."id" AND (
      NOT EXISTS (SELECT 1 FROM json_each(${ids}) k WHERE k."value" = m."id")
      OR (CASE WHEN ${unreadMemberSql(before)} THEN 0 ELSE 1 END) = 1))
    AND NOT EXISTS (SELECT 1 FROM "WorkspacePREvent" l WHERE l."deliveryId" = d."id"))`;
}

/**
 * Deliveries worth testing with `prunableDeliveryUnitSql`, found through
 * indexes: settled deliveries of ARCHIVED workspaces (`Workspace.status`, then
 * `(workspaceId, state)`), and the deliveries (or NULL) of facts whose key lies
 * in their PR's epoch namespace but outside the current epoch's prefix: two
 * ranges of `(prId, deduplicationKey)` per PR, so current-epoch history is
 * never visited. `CROSS JOIN` fixes that loop order; given the choice, SQLite
 * walks every bound fact through the `batchId` index instead.
 */
function deliveryCandidatesSql() {
  const epochs = Prisma.sql`p."id" || ':epoch:'`;
  const current = Prisma.sql`p."id" || ':epoch:' || mo."eventEpoch"`;
  const boundIn = (from: Prisma.Sql, to: Prisma.Sql) => Prisma.sql`
    SELECT m."batchId" FROM "WorkspacePR" p
    CROSS JOIN "WorkspacePRMonitoring" mo
    CROSS JOIN "WorkspacePREvent" m
    WHERE mo."workspaceId" = p."workspaceId" AND m."prId" = p."id"
      AND m."deduplicationKey" >= ${from} AND m."deduplicationKey" < ${to}`;
  return Prisma.sql`
    SELECT d."id" FROM "Workspace" w
    JOIN "WorkspacePRDelivery" d ON d."workspaceId" = w."id"
      AND d."state" IN (${Prisma.join(PRUNABLE_DELIVERY_STATES)})
    WHERE w."status" = 'ARCHIVED'
    UNION ${boundIn(epochs, Prisma.sql`${current} || ':'`)}
    UNION ${boundIn(Prisma.sql`${current} || ';'`, Prisma.sql`p."id" || ':epoch;'`)}`;
}

/**
 * Whether a stored payload's observation still carries the PR's review list,
 * as facts written before 2026-11-22 (#3288) did. Facts are now written with
 * `actionableReviews: []` and no `resolvedReviewIds`; a feedback fact names its
 * own review in `payload.reviews`, which is not touched.
 */
export const carriesReviewListSql = Prisma.sql`coalesce(CASE WHEN json_valid("payload") THEN
  coalesce(json_array_length("payload", '$.observation.actionableReviews'), 0) > 0
  OR json_type("payload", '$.observation.resolvedReviewIds') IS NOT NULL END, 0)`;

/**
 * The payload without the observation's review list. SQLite rewrites only the
 * two paths and keeps every other key, its position and its stored text.
 */
export const withoutReviewListSql = Prisma.sql`json_remove(
  json_set("payload", '$.observation.actionableReviews', json('[]')),
  '$.observation.resolvedReviewIds')`;

/** The same test in TypeScript; a payload that is not a valid PR fact is never rewritten. */
function carriesReviewList(payload: unknown): boolean {
  const parsed = prFactPayloadSchema.safeParse(payload);
  return (
    parsed.success &&
    (parsed.data.observation.actionableReviews.length > 0 ||
      parsed.data.observation.resolvedReviewIds !== undefined)
  );
}

const idRowsSchema = z.array(z.object({ id: z.string().min(1) }));
const reviewListWindowSchema = z.array(
  z.object({
    id: z.string().min(1),
    carries: z.union([z.bigint(), z.number()]).transform((value) => Number(value) === 1),
  })
);

/** The workspace `w` and monitoring `mo` of delivery `d` that its unit predicate reads. */
const deliveryUnitJoins = Prisma.sql`JOIN "Workspace" w ON w."id" = d."workspaceId"
  LEFT JOIN "WorkspacePRMonitoring" mo ON mo."workspaceId" = d."workspaceId"`;

/**
 * Up to `limit` prunable delivery IDs after `afterId`, in ID order. `CROSS JOIN`
 * makes SQLite drive the loop from the candidates instead of walking every
 * delivery in ID order. Read only.
 */
export async function findPrunableDeliveryIds(
  client: Prisma.TransactionClient,
  input: { before: Date; afterId: string; limit: number }
): Promise<string[]> {
  const rows = idRowsSchema.parse(
    await client.$queryRaw`WITH "candidate"("id") AS (${deliveryCandidatesSql()})
      SELECT d."id" FROM "candidate" c
      CROSS JOIN "WorkspacePRDelivery" d ${deliveryUnitJoins}
      WHERE d."id" = c."id" AND c."id" > ${input.afterId}
        AND ${prunableDeliveryUnitSql(input.before)}
      ORDER BY d."id" LIMIT ${input.limit}`
  );
  return rows.map((row) => row.id);
}

/**
 * The given deliveries that are still prunable units, with their member IDs.
 * Run in the deleting transaction: it re-applies the SQL predicate and then
 * `getFrozenDeliveryMembers`, the check backup export and every lifecycle
 * transition apply, so a unit is only ever deleted whole. Read only.
 */
export async function confirmPrunableDeliveryUnits(
  tx: Prisma.TransactionClient,
  ids: string[],
  before: Date
): Promise<{ id: string; memberIds: string[] }[]> {
  const confirmed = idRowsSchema
    .parse(
      await tx.$queryRaw`SELECT d."id" FROM "WorkspacePRDelivery" d ${deliveryUnitJoins}
        WHERE d."id" IN (${Prisma.join(ids)}) AND ${prunableDeliveryUnitSql(before)}`
    )
    .map((row) => row.id);
  if (!confirmed.length) {
    return [];
  }
  const deliveries = await tx.workspacePRDelivery.findMany({
    where: { id: { in: confirmed } },
    select: { id: true, workspaceId: true, eventIds: true },
  });
  const rows = await tx.workspacePREvent.findMany({
    where: { OR: [{ batchId: { in: confirmed } }, { deliveryId: { in: confirmed } }] },
    select: { id: true, workspaceId: true, batchId: true, deliveryId: true },
  });
  return deliveries.flatMap((delivery) => {
    const members = getFrozenDeliveryMembers(delivery, rows);
    return members ? [{ id: delivery.id, memberIds: members.map((member) => member.id) }] : [];
  });
}

/**
 * One window of `limit` ledger rows in ID order after `afterId`, and which of
 * them carry a review list. Only IDs leave SQLite. Read only.
 */
export async function scanReviewListWindow(
  client: Prisma.TransactionClient,
  input: { afterId: string; limit: number }
) {
  const window = reviewListWindowSchema.parse(
    await client.$queryRaw`SELECT "id", ${carriesReviewListSql} AS "carries" FROM (
      SELECT "id", "payload" FROM "WorkspacePREvent" WHERE "id" > ${input.afterId}
      ORDER BY "id" LIMIT ${input.limit})`
  );
  return {
    scanned: window.length,
    lastId: window.at(-1)?.id ?? null,
    carrierIds: window.filter((row) => row.carries).map((row) => row.id),
  };
}

/** The given rows whose payload parses as a PR fact and carries a review list. Read only. */
export async function filterParsedReviewListCarriers(
  tx: Prisma.TransactionClient,
  ids: string[]
): Promise<string[]> {
  const rows = await tx.workspacePREvent.findMany({
    where: { id: { in: ids } },
    select: { id: true, payload: true },
  });
  return rows.filter((row) => carriesReviewList(row.payload)).map((row) => row.id);
}
