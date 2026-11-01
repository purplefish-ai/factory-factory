import { prisma } from '@/backend/db';
import { ApplicationError } from '@/backend/lib/application-error';
import {
  agentEventOrderInputSchema,
  agentSourceHealthSchema,
  type AgentEventOrderInput,
} from '@/shared/agent-runtime';
import { agentIssueEventPageSchema, type AgentIssueEventPage } from '@/shared/agent-source';
import {
  agentGithubCursorSchema,
  type AgentGithubCursor,
  type AgentSourceEntry,
} from '@/shared/agent-source-state';
import type { Prisma } from '@prisma-gen/client';
import { agentEventAccessor } from './agent-event.accessor';
import { ledgerTransaction } from './agent-ledger-transaction';
import {
  listTargets,
  assertTarget,
  entriesFor,
  getState,
  getBaseline,
  historicalHeadOrder,
} from './agent-source-queries';
import { capturePage, discontinuity, newScan, resumeScan, verifyPage } from './agent-source-scan';
type Tx = Prisma.TransactionClient;
function health(
  state: 'READY' | 'CATCHING_UP' | 'ERROR' | 'RECOVERY_REQUIRED',
  reasonCode: string | null = null
) {
  return agentSourceHealthSchema.parse({ state, reasonCode, updatedAt: new Date().toISOString() });
}
function baselineOrder(cursor: AgentGithubCursor | null, head: string | null, lastOrder: number) {
  if (!cursor) {
    return lastOrder;
  }
  if (head === null && cursor.committedHeadEventId !== null) {
    discontinuity();
  }
  return !cursor.scan && cursor.committedHeadEventId === head ? lastOrder : null;
}
async function initializeSource(
  tx: Tx,
  connectionId: string,
  headEventId: string | null,
  lastOrder: number
) {
  if (lastOrder) {
    discontinuity();
  }
  const cursor: AgentGithubCursor = {
    version: 1,
    provider: 'GITHUB',
    committedHeadEventId: headEventId,
    scan: null,
  };
  await tx.agentSourceState.upsert({
    where: { connectionId },
    create: { connectionId, cursor, isReady: true, health: health('READY') },
    update: { cursor, isReady: true, health: health('READY') },
  });
}
async function prepareBaseline(connectionId: string, headEventId: string | null) {
  const id = await ledgerTransaction(async (tx) => {
    await assertTarget(tx, connectionId);
    const state = await tx.agentSourceState.findUnique({ where: { connectionId } });
    const cursor = state?.cursor ? agentGithubCursorSchema.parse(state.cursor) : null;
    if (
      state?.health &&
      agentSourceHealthSchema.parse(state.health).state === 'RECOVERY_REQUIRED'
    ) {
      discontinuity();
    }
    if (!cursor) {
      await initializeSource(tx, connectionId, headEventId, state?.lastSourceOrder ?? 0);
    }
    const order =
      baselineOrder(cursor, headEventId, state?.lastSourceOrder ?? 0) ??
      (await historicalHeadOrder(tx, connectionId, headEventId));
    return (
      await tx.agentSourceBaseline.create({
        data: {
          connectionId,
          headEventId,
          sourceOrder: order,
          afterHeadEventId: cursor?.scan?.fixedHeadEventId ?? cursor?.committedHeadEventId ?? null,
        },
      })
    ).id;
  });
  const result = await getBaseline(connectionId, id);
  if (!result) {
    throw new Error('Prepared baseline missing');
  }
  return result;
}
async function setFailure(connectionId: string, reasonCode: string, recovery = false) {
  await prisma.agentSourceState.upsert({
    where: { connectionId },
    create: {
      connectionId,
      isReady: false,
      health: health(recovery ? 'RECOVERY_REQUIRED' : 'ERROR', reasonCode),
    },
    update: {
      isReady: false,
      health: health(recovery ? 'RECOVERY_REQUIRED' : 'ERROR', reasonCode),
    },
  });
}
async function resume(connectionId: string) {
  await ledgerTransaction(async (tx) => {
    const state = await tx.agentSourceState.findUnique({ where: { connectionId } });
    if (!state?.cursor) {
      return;
    }
    const cursor = agentGithubCursorSchema.parse(state.cursor);
    if (!cursor.scan) {
      return;
    }
    cursor.scan = resumeScan(cursor.scan);
    await tx.agentSourceState.update({ where: { connectionId }, data: { cursor } });
  });
}

function beginPage(cursor: AgentGithubCursor, requestPage: number, page: AgentIssueEventPage) {
  if (cursor.scan) {
    return true;
  }
  if (requestPage !== 1) {
    discontinuity();
  }
  const head = page.events[0]?.providerEventId ?? null;
  if (head === cursor.committedHeadEventId) {
    return false;
  }
  if (head === null) {
    discontinuity();
  }
  cursor.scan = newScan(head, cursor.committedHeadEventId);
  return true;
}
async function ingestEntries(tx: Tx, connectionId: string, fresh: AgentIssueEventPage['events']) {
  const entries: AgentSourceEntry[] = [];
  for (const item of fresh) {
    if (item.payload && (item.payload.provider !== 'GITHUB' || item.payload.action !== 'labeled')) {
      discontinuity();
    }
    const event = item.payload
      ? await agentEventAccessor.ingestEventInTransaction(tx, {
          connectionId,
          providerEventId: item.providerEventId,
          payload: item.payload,
        })
      : null;
    if (event) {
      const stored = await tx.agentEvent.findUniqueOrThrow({ where: { id: event.eventId } });
      if (stored.sourceOrder !== null) {
        discontinuity();
      }
    }
    entries.push({ providerEventId: item.providerEventId, eventId: event?.eventId ?? null });
  }
  return entries;
}
async function savePage(connectionId: string, requestPage: number, pageValue: AgentIssueEventPage) {
  const page = agentIssueEventPageSchema.parse(pageValue);
  await ledgerTransaction(async (tx) => {
    await assertTarget(tx, connectionId);
    const state = await tx.agentSourceState.findUniqueOrThrow({ where: { connectionId } });
    const cursor = agentGithubCursorSchema.parse(state.cursor);
    if (!beginPage(cursor, requestPage, page)) {
      await assertRequiredBaselines(tx, connectionId, [], cursor.committedHeadEventId);
      await tx.agentSourceState.update({
        where: { connectionId },
        data: { isReady: true, health: health('READY'), lastObservedAt: new Date() },
      });
      return;
    }
    const scan = cursor.scan;
    if (!scan) {
      discontinuity();
    }
    if (scan.phase === 'FINALIZE' || scan.nextPage !== requestPage) {
      discontinuity();
    }
    const captured = await entriesFor(tx, connectionId, scan.id);
    const phase = scan.phase;
    const entries: AgentSourceEntry[] = [];
    if (phase === 'CAPTURE') {
      entries.push(...(await ingestEntries(tx, connectionId, capturePage(scan, captured, page))));
    } else {
      verifyPage(scan, captured, page);
    }
    await tx.agentSourcePage.create({
      data: {
        connectionId,
        scanId: scan.id,
        ordinal: scan.observationCount++,
        phase,
        requestPage,
        nextPage: page.nextPage,
        evidence: { ids: page.events.map((item) => item.providerEventId), entries },
      },
    });
    await tx.agentSourceState.update({
      where: { connectionId },
      data: { cursor, isReady: true, health: health('CATCHING_UP'), lastObservedAt: new Date() },
    });
  });
}

async function resolveBaselines(
  tx: Tx,
  connectionId: string,
  entries: AgentSourceEntry[],
  lastSourceOrder: number,
  previousBoundaryEventId: string | null
) {
  // A control head inherits the ordinal of the latest executable event at/before it.
  const baselineRows = await tx.agentSourceBaseline.findMany({
    where: { connectionId, sourceOrder: null },
  });
  let ordinal = lastSourceOrder;
  const orders = new Map<string, number>();
  for (const entry of entries) {
    orders.set(entry.providerEventId, ordinal);
    if (entry.eventId) {
      ordinal--;
    }
  }
  if (previousBoundaryEventId !== null) {
    orders.set(previousBoundaryEventId, ordinal);
  }
  for (const baseline of baselineRows) {
    const sourceOrder = baseline.headEventId === null ? 0 : orders.get(baseline.headEventId);
    if (sourceOrder !== undefined) {
      await tx.agentSourceBaseline.update({ where: { id: baseline.id }, data: { sourceOrder } });
    }
  }
}

async function finalizeInTransaction(tx: Tx, connectionId: string, requestedIds?: string[]) {
  await assertTarget(tx, connectionId);
  const state = await tx.agentSourceState.findUniqueOrThrow({ where: { connectionId } });
  const cursor = agentGithubCursorSchema.parse(state.cursor);
  const scan = cursor.scan;
  if (scan?.phase !== 'FINALIZE') {
    discontinuity();
  }
  const entries = await entriesFor(tx, connectionId, scan.id);
  await assertRequiredBaselines(tx, connectionId, entries, scan.previousBoundaryEventId);
  const ordered = entries
    .slice()
    .reverse()
    .flatMap((entry) => (entry.eventId ? [entry.eventId] : []));
  const eventIds = ordered.slice(scan.finalizedCount, scan.finalizedCount + 1000);
  if (requestedIds && JSON.stringify(requestedIds) !== JSON.stringify(eventIds)) {
    discontinuity();
  }
  const result = eventIds.length
    ? await agentEventAccessor.finalizeEventOrderInTransaction(
        tx,
        { connectionId, eventIds },
        state.lastSourceOrder
      )
    : [];
  const lastSourceOrder = result.at(-1)?.sourceOrder ?? state.lastSourceOrder;
  scan.finalizedCount += eventIds.length;
  if (scan.finalizedCount === ordered.length) {
    await resolveBaselines(
      tx,
      connectionId,
      entries,
      lastSourceOrder,
      scan.previousBoundaryEventId
    );
    await tx.agentSourcePage.create({
      data: {
        connectionId,
        scanId: scan.id,
        ordinal: scan.observationCount,
        phase: 'FINALIZED',
        requestPage: scan.nextPage,
        sourceOrder: lastSourceOrder,
        evidence: { ids: [scan.fixedHeadEventId], entries: [] },
      },
    });
    cursor.committedHeadEventId = scan.fixedHeadEventId;
    cursor.scan = null;
  }
  await tx.agentSourceState.update({
    where: { connectionId },
    data: {
      cursor,
      lastSourceOrder,
      isReady: true,
      health: health(cursor.scan ? 'CATCHING_UP' : 'READY'),
    },
  });
  return result;
}

async function assertRequiredBaselines(
  tx: Tx,
  connectionId: string,
  entries: AgentSourceEntry[],
  previousHead: string | null
) {
  const required = await tx.agentSourceBaseline.findMany({
    where: { connectionId, sourceOrder: null, afterHeadEventId: previousHead },
  });
  const captured = new Set(entries.map((entry) => entry.providerEventId));
  for (const baseline of required) {
    if (
      baseline.headEventId !== previousHead &&
      baseline.headEventId !== null &&
      !captured.has(baseline.headEventId)
    ) {
      discontinuity();
    }
  }
}
async function finalizeNextChunk(connectionId: string) {
  return await ledgerTransaction((tx) => finalizeInTransaction(tx, connectionId));
}
async function finalizeEventOrder(value: AgentEventOrderInput) {
  const input = agentEventOrderInputSchema.parse(value);
  return await ledgerTransaction(async (tx) => {
    const existing = await tx.agentEvent.findMany({
      where: { connectionId: input.connectionId, id: { in: input.eventIds } },
    });
    if (existing.length !== input.eventIds.length) {
      throw new ApplicationError(
        'INVALID_INPUT',
        'Every event must belong to this source connection.'
      );
    }
    if (existing.every((event) => event.sourceOrder !== null)) {
      return await agentEventAccessor.finalizeEventOrderInTransaction(tx, input, 0);
    }
    const source = await tx.agentSourceState.findUnique({
      where: { connectionId: input.connectionId },
    });
    if (!source?.cursor) {
      discontinuity();
    }
    return await finalizeInTransaction(tx, input.connectionId, input.eventIds);
  });
}
export const agentSourceAccessor = {
  listTargets,
  getState,
  getBaseline,
  prepareBaseline,
  setFailure,
  resume,
  savePage,
  finalizeNextChunk,
  finalizeEventOrder,
};
