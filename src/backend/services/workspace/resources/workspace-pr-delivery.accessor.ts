import { z } from 'zod';
import type { Prisma, WorkspacePRDelivery, WorkspacePREvent } from '@prisma-gen/client';

const membershipSchema = z.array(z.string().min(1)).min(1);
export function projectDeliveryEvent(
  event: WorkspacePREvent,
  delivery?: WorkspacePRDelivery
): WorkspacePREvent {
  if (!delivery) {
    return event;
  }
  if (delivery.state === 'BLOCKED') {
    return { ...event, state: 'DISPATCHING' };
  }
  return {
    ...event,
    deliveryId: delivery.id,
    state: delivery.state,
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
    return projectDeliveryEvent(event, id ? byId.get(id) : undefined);
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
        return id ? [id] : [];
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
    const ids = membershipSchema.parse(delivery.eventIds);
    const members = events.filter(
      (event) => event.batchId === delivery.id || event.deliveryId === delivery.id
    );
    if (
      ids.length !== new Set(ids).size ||
      members.length !== ids.length ||
      members.some((event) => !ids.includes(event.id) || event.workspaceId !== delivery.workspaceId)
    ) {
      throw new Error('Cannot export incomplete PR delivery membership');
    }
    if (delivery.state === 'BLOCKED' && members.some((event) => event.deliveryId !== delivery.id)) {
      throw new Error('Cannot flatten blocked normalized PR delivery evidence');
    }
  }
  const byId = new Map(deliveries.map((delivery) => [delivery.id, delivery]));
  return events.map((event) => {
    const delivery = byId.get(event.batchId ?? event.deliveryId ?? '');
    return delivery?.state === 'BLOCKED' ? event : projectDeliveryEvent(event, delivery);
  });
}
