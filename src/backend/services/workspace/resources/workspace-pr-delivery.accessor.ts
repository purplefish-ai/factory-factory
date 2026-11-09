import { z } from 'zod';
import {
  type PRDeliveryState,
  prDeliveryStateSchema,
  prEventStateSchema,
} from '@/shared/schemas/pr-event.schema';
import type { Prisma, WorkspacePRDelivery, WorkspacePREvent } from '@prisma-gen/client';

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
/** Validate the complete explicit membership before export or any lifecycle transition. */
export function getFrozenDeliveryMembers(
  delivery: Pick<WorkspacePRDelivery, 'id' | 'workspaceId' | 'eventIds'>,
  events: WorkspacePREvent[]
): WorkspacePREvent[] | null {
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
  // verbatim but is no longer live, so neither overlays its frozen fields.
  if (state === PR_DELIVERY_STATE.BLOCKED) {
    return { ...event, state: PR_EVENT_STATE.DISPATCHING };
  }
  if (state === PR_DELIVERY_STATE.DISMISSED) {
    return { ...event, state: PR_EVENT_STATE.CANCELLED };
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
