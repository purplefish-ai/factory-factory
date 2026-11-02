import type { PRRecovery } from '@/shared/schemas/pr-recovery.schema';
import type { Prisma } from '@prisma-gen/client';
type Fact = PRRecovery['events'][number];
type FactIdentity = Pick<Fact, 'id' | 'workspaceId' | 'prId' | 'deduplicationKey'>;
function factKeys(row: FactIdentity): string[] {
  return [
    JSON.stringify(['id', row.id]),
    JSON.stringify(['workspace', row.workspaceId, row.deduplicationKey]),
    ...(row.prId === null ? [] : [JSON.stringify(['pr', row.prId, row.deduplicationKey])]),
  ];
}
async function existingFactKeys(tx: Prisma.TransactionClient, events: Fact[]) {
  const keys = new Set<string>();
  for (let start = 0; start < events.length; start += 100) {
    const OR = events
      .slice(start, start + 100)
      .flatMap((row): Prisma.WorkspacePREventWhereInput[] => [
        { id: row.id },
        { workspaceId: row.workspaceId, deduplicationKey: row.deduplicationKey },
        ...(row.prId === null ? [] : [{ prId: row.prId, deduplicationKey: row.deduplicationKey }]),
      ]);
    const rows = await tx.workspacePREvent.findMany({
      where: { OR },
      select: { id: true, workspaceId: true, prId: true, deduplicationKey: true },
    });
    for (const row of rows) {
      for (const key of factKeys(row)) {
        keys.add(key);
      }
    }
  }
  return keys;
}
function units(snapshot: PRRecovery) {
  const byId = new Map(snapshot.events.map((row) => [row.id, row]));
  const covered = new Set<string>();
  const result: { deliveryId: string | null; events: Fact[] }[] = [];
  for (const delivery of snapshot.deliveries) {
    const events = delivery.eventIds.map((id) => {
      const event = byId.get(id);
      if (!event) {
        throw new Error('Incomplete imported PR delivery membership');
      }
      covered.add(id);
      return event;
    });
    result.push({ deliveryId: delivery.id, events });
  }
  const legacy = new Map<string, Fact[]>();
  for (const event of snapshot.events) {
    if (covered.has(event.id)) {
      continue;
    }
    const id = event.batchId ?? event.deliveryId;
    if (id === null) {
      result.push({ deliveryId: null, events: [event] });
    } else {
      const members = legacy.get(id) ?? [];
      members.push(event);
      legacy.set(id, members);
    }
  }
  for (const [deliveryId, events] of legacy) {
    result.push({ deliveryId, events });
  }
  return result;
}
async function existingDeliveryIds(tx: Prisma.TransactionClient, deliveryIds: string[]) {
  const occupiedDeliveries = new Set<string>();
  for (let start = 0; start < deliveryIds.length; start += 200) {
    const rows = await tx.workspacePRDelivery.findMany({
      where: { id: { in: deliveryIds.slice(start, start + 200) } },
      select: { id: true },
    });
    for (const row of rows) {
      occupiedDeliveries.add(row.id);
    }
  }
  return occupiedDeliveries;
}
/** A frozen effect is indivisible: a colliding member excludes its whole batch. */
export async function selectPRRecoveryWithoutCollisions(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  snapshot: PRRecovery
): Promise<PRRecovery> {
  if (
    snapshot.deliveries.some((row) => row.workspaceId !== workspaceId) ||
    snapshot.events.some((row) => row.workspaceId !== workspaceId)
  ) {
    throw new Error('Imported PR recovery belongs to another workspace');
  }
  const groups = units(snapshot);
  const deliveryIds = groups.flatMap((group) =>
    group.deliveryId === null ? [] : [group.deliveryId]
  );
  const occupiedDeliveries = await existingDeliveryIds(tx, deliveryIds);
  const occupiedFacts = await existingFactKeys(tx, snapshot.events);
  const ownedPRs = new Set(
    (await tx.workspacePR.findMany({ where: { workspaceId }, select: { id: true } })).map(
      (row) => row.id
    )
  );
  const acceptedEvents = new Set<string>();
  const acceptedDeliveries = new Set<string>();
  for (const group of groups) {
    const keys = group.events.flatMap(factKeys);
    if (
      (group.deliveryId !== null && occupiedDeliveries.has(group.deliveryId)) ||
      group.events.some((row) => row.prId !== null && !ownedPRs.has(row.prId)) ||
      new Set(keys).size !== keys.length ||
      keys.some((key) => occupiedFacts.has(key))
    ) {
      continue;
    }
    for (const key of keys) {
      occupiedFacts.add(key);
    }
    for (const event of group.events) {
      acceptedEvents.add(event.id);
    }
    if (group.deliveryId !== null) {
      occupiedDeliveries.add(group.deliveryId);
      acceptedDeliveries.add(group.deliveryId);
    }
  }
  return {
    deliveries: snapshot.deliveries.filter((row) => acceptedDeliveries.has(row.id)),
    events: snapshot.events.filter((row) => acceptedEvents.has(row.id)),
  };
}
