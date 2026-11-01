import { ApplicationError } from '@/backend/lib/application-error';
import {
  agentEventInputSchema,
  agentEventOrderInputSchema,
  agentSourceOrderSchema,
  type AgentEventInput,
  type AgentEventOrderInput,
} from '@/shared/agent-runtime';
import type { Prisma } from '@prisma-gen/client';
import { ledgerTransaction } from './agent-ledger-transaction';

const DAY_MS = 24 * 60 * 60 * 1000;

async function ingestEvent(
  event: AgentEventInput
): Promise<{ eventId: string; duplicate: boolean }> {
  return await ledgerTransaction((tx) => ingestEventInTransaction(tx, event));
}

async function ingestEventInTransaction(tx: Prisma.TransactionClient, event: AgentEventInput) {
  const input = agentEventInputSchema.parse(event);
  const connection = await tx.agentConnection.findUnique({ where: { id: input.connectionId } });
  const payload = input.payload;
  const identity =
    payload.provider === 'GITHUB' ? `gh:${payload.repositoryId}` : payload.workspaceId;
  if (
    !connection ||
    connection.provider !== payload.provider ||
    connection.externalId !== identity
  ) {
    throw new ApplicationError(
      'INVALID_INPUT',
      'The normalized event does not belong to this source connection.'
    );
  }
  const existing = await tx.agentEvent.findUnique({
    where: {
      connectionId_providerEventId: {
        connectionId: input.connectionId,
        providerEventId: input.providerEventId,
      },
    },
  });
  if (existing) {
    return { eventId: existing.id, duplicate: true };
  }
  const occurredAt = new Date(payload.occurredAt);
  const observedAt = new Date(payload.observedAt);
  const created = await tx.agentEvent.create({
    data: {
      ...input,
      occurredAt,
      observedAt,
      payloadExpiresAt: new Date(occurredAt.getTime() + 30 * DAY_MS),
      identityExpiresAt: new Date(occurredAt.getTime() + 90 * DAY_MS),
    },
  });
  return { eventId: created.id, duplicate: false };
}

/** Called only after a complete fixed-head interval is captured, in oldest-to-newest API order. */
async function finalizeEventOrderInTransaction(
  tx: Prisma.TransactionClient,
  value: AgentEventOrderInput,
  lastSourceOrder: number
) {
  const input = agentEventOrderInputSchema.parse(value);
  const connection = await tx.agentConnection.findUnique({ where: { id: input.connectionId } });
  if (connection?.provider !== 'GITHUB') {
    throw new ApplicationError('INVALID_INPUT', 'API ordering requires a GitHub source.');
  }
  const events = await tx.agentEvent.findMany({
    where: { connectionId: input.connectionId, id: { in: input.eventIds } },
  });
  if (events.length !== input.eventIds.length) {
    throw new ApplicationError(
      'INVALID_INPUT',
      'Every event must belong to this source connection.'
    );
  }
  const byId = new Map(events.map((event) => [event.id, event]));
  const ordered = input.eventIds.map((id) => {
    const event = byId.get(id);
    if (!event) {
      throw new ApplicationError(
        'INVALID_INPUT',
        'The event is missing from this source interval.'
      );
    }
    return event;
  });
  if (ordered.every((event) => event.sourceOrder !== null)) {
    const finalized = ordered.map((event) => ({
      eventId: event.id,
      sourceOrder: agentSourceOrderSchema.parse(event.sourceOrder),
    }));
    if (
      finalized.some(
        (event, index) => event.sourceOrder <= (finalized[index - 1]?.sourceOrder ?? 0)
      )
    ) {
      throw new ApplicationError(
        'CONFLICT',
        'The immutable source order does not match this interval.'
      );
    }
    return finalized;
  }
  if (ordered.some((event) => event.sourceOrder !== null)) {
    throw new ApplicationError(
      'CONFLICT',
      'Finalize only the new interval; overlap events already have immutable ordering.'
    );
  }
  let ordinal = lastSourceOrder;
  const result: Array<{ eventId: string; sourceOrder: number }> = [];
  for (const event of ordered) {
    ordinal = agentSourceOrderSchema.parse(ordinal + 1);
    await tx.agentEvent.update({ where: { id: event.id }, data: { sourceOrder: ordinal } });
    result.push({ eventId: event.id, sourceOrder: ordinal });
  }
  return result;
}

export const agentEventAccessor = {
  ingestEvent,
  ingestEventInTransaction,
  finalizeEventOrderInTransaction,
};
