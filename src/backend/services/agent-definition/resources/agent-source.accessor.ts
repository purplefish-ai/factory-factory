import { ApplicationError } from '@/backend/lib/application-error';
import {
  agentEventOrderInputSchema,
  agentSourceHealthSchema,
  type AgentEventOrderInput,
  isAgentGithubExecutableAction,
} from '@/shared/agent-runtime';
import { agentIssueEventPageSchema, type AgentIssueEventPage } from '@/shared/agent-source';
import {
  agentGithubCursorSchema,
  type AgentGithubCursor,
  type AgentSourceEntry,
} from '@/shared/agent-source-state';
import { Prisma } from '@prisma-gen/client';
import { agentEventAccessor } from './agent-event.accessor';
import { ledgerTransaction } from './agent-ledger-transaction';
import { agentSourceCheckpointAccessor } from './agent-source-checkpoint.accessor';
import {
  listTargets,
  assertTarget,
  assertCheckpointProof,
  entriesFor,
  getState,
  getBaseline,
  historicalHeadOrder,
  sourceEpoch,
  type SourceEpoch,
} from './agent-source-queries';
import { capturePage, discontinuity, newScan, resumeScan, verifyPage } from './agent-source-scan';
import { pauseTriggers } from './agent-trigger-pause';
type Tx = Prisma.TransactionClient;
function requiresRecovery(state: { health: unknown } | null) {
  return (
    state?.health != null &&
    agentSourceHealthSchema.parse(state.health).state === 'RECOVERY_REQUIRED'
  );
}
function assertOperational(state: { health: unknown } | null) {
  if (requiresRecovery(state)) {
    discontinuity();
  }
}
function health(
  state: 'READY' | 'CATCHING_UP' | 'DISCONNECTED' | 'ERROR' | 'RECOVERY_REQUIRED',
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
  state: { lastSourceOrder: number; epochStartSourceOrder: number } | null
) {
  // Only a source that has ordered nothing in its current epoch can start from a fresh head.
  if ((state?.lastSourceOrder ?? 0) !== (state?.epochStartSourceOrder ?? 0)) {
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
    assertOperational(state);
    const source = sourceEpoch(connectionId, state);
    await assertCheckpointProof(tx, source);
    const cursor = state?.cursor ? agentGithubCursorSchema.parse(state.cursor) : null;
    if (!cursor) {
      await initializeSource(tx, connectionId, headEventId, state);
    }
    const order =
      baselineOrder(cursor, headEventId, state?.lastSourceOrder ?? 0) ??
      (await historicalHeadOrder(tx, source, headEventId));
    // Every ordinal of this epoch is at or after the high water it started from.
    if (order !== null && order < source.epochStartSourceOrder) {
      discontinuity();
    }
    return (
      await tx.agentSourceBaseline.create({
        data: {
          connectionId,
          epoch: source.epoch,
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
  await ledgerTransaction(async (tx) => {
    const state = await tx.agentSourceState.findUnique({ where: { connectionId } });
    if (requiresRecovery(state)) {
      return;
    }
    await tx.agentSourceState.upsert({
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
  });
}
async function resume(connectionId: string) {
  await ledgerTransaction(async (tx) => {
    const state = await tx.agentSourceState.findUnique({ where: { connectionId } });
    assertOperational(state);
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
async function ingestEntries(
  tx: Tx,
  { connectionId, epoch }: SourceEpoch,
  fresh: AgentIssueEventPage['events']
) {
  const entries: AgentSourceEntry[] = [];
  for (const item of fresh) {
    if (
      item.payload &&
      (item.payload.provider !== 'GITHUB' || !isAgentGithubExecutableAction(item.payload.action))
    ) {
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
      // An event captured before a reset is never ordered, so it can never become eligible.
      if (stored.sourceOrder !== null || stored.sourceEpoch !== epoch) {
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
    assertOperational(state);
    const source = sourceEpoch(connectionId, state);
    const cursor = agentGithubCursorSchema.parse(state.cursor);
    if (!beginPage(cursor, requestPage, page)) {
      await assertRequiredBaselines(tx, source, [], cursor.committedHeadEventId);
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
      entries.push(...(await ingestEntries(tx, source, capturePage(scan, captured, page))));
    } else {
      verifyPage(scan, captured, page);
    }
    const savedPage = await tx.agentSourcePage.create({
      data: {
        connectionId,
        epoch: source.epoch,
        scanId: scan.id,
        ordinal: scan.observationCount++,
        phase,
        requestPage,
        nextPage: page.nextPage,
        evidence: { ids: page.events.map((item) => item.providerEventId), entries },
      },
    });
    await agentSourceCheckpointAccessor.checkpointPage(tx, savedPage, {
      headEventId: scan.previousBoundaryEventId,
      sourceOrder: state.lastSourceOrder,
    });
    await tx.agentSourceState.update({
      where: { connectionId },
      data: {
        cursor: agentGithubCursorSchema.parse(cursor),
        isReady: true,
        health: health('CATCHING_UP'),
        lastObservedAt: new Date(),
      },
    });
  });
}

async function resolveBaselines(
  tx: Tx,
  { connectionId, epoch, epochStartSourceOrder }: SourceEpoch,
  entries: AgentSourceEntry[],
  lastSourceOrder: number,
  previousBoundaryEventId: string | null
) {
  // A control head inherits the ordinal of the latest executable event at/before it.
  // afterHeadEventId makes missing evidence due; it does not exclude an exact
  // head witness from a scan that was already in flight during preparation.
  // Pins issued in an earlier epoch keep their answer; this interval is not evidence for them.
  const baselineRows = await tx.agentSourceBaseline.findMany({
    where: { connectionId, epoch, sourceOrder: null },
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
    const sourceOrder =
      baseline.headEventId === null ? epochStartSourceOrder : orders.get(baseline.headEventId);
    if (sourceOrder !== undefined) {
      await tx.agentSourceBaseline.update({ where: { id: baseline.id }, data: { sourceOrder } });
    }
  }
}

async function finalizeInTransaction(tx: Tx, connectionId: string, requestedIds?: string[]) {
  await assertTarget(tx, connectionId);
  const state = await tx.agentSourceState.findUniqueOrThrow({ where: { connectionId } });
  assertOperational(state);
  const source = sourceEpoch(connectionId, state);
  const cursor = agentGithubCursorSchema.parse(state.cursor);
  const scan = cursor.scan;
  if (scan?.phase !== 'FINALIZE') {
    discontinuity();
  }
  const entries = await entriesFor(tx, connectionId, scan.id);
  await assertRequiredBaselines(tx, source, entries, scan.previousBoundaryEventId);
  const ordered = entries
    .slice()
    .reverse()
    .flatMap((entry) => (entry.eventId ? [entry.eventId] : []));
  const eventIds = ordered.slice(scan.finalizedCount, scan.finalizedCount + 1000);
  if (requestedIds && JSON.stringify(requestedIds) !== JSON.stringify(eventIds)) {
    discontinuity();
  }
  // Capture already refuses earlier epochs' events; ordering one would make it eligible.
  const epochs = await tx.agentEvent.findMany({
    where: { id: { in: eventIds } },
    select: { sourceEpoch: true },
  });
  if (epochs.some((event) => event.sourceEpoch !== source.epoch)) {
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
    await resolveBaselines(tx, source, entries, lastSourceOrder, scan.previousBoundaryEventId);
    const finalizedPage = await tx.agentSourcePage.create({
      data: {
        connectionId,
        epoch: source.epoch,
        scanId: scan.id,
        ordinal: scan.observationCount,
        phase: 'FINALIZED',
        requestPage: scan.nextPage,
        sourceOrder: lastSourceOrder,
        evidence: { ids: [scan.fixedHeadEventId], entries: [] },
      },
    });
    await agentSourceCheckpointAccessor.checkpointPage(tx, finalizedPage);
    cursor.committedHeadEventId = scan.fixedHeadEventId;
    cursor.scan = null;
  }
  await tx.agentSourceState.update({
    where: { connectionId },
    data: {
      cursor: agentGithubCursorSchema.parse(cursor),
      lastSourceOrder,
      isReady: true,
      health: health(cursor.scan ? 'CATCHING_UP' : 'READY'),
    },
  });
  return result;
}

async function assertRequiredBaselines(
  tx: Tx,
  { connectionId, epoch }: SourceEpoch,
  entries: AgentSourceEntry[],
  previousHead: string | null
) {
  const required = await tx.agentSourceBaseline.findMany({
    where: { connectionId, epoch, sourceOrder: null, afterHeadEventId: previousHead },
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
function maintainCheckpoints(connectionId: string) {
  return agentSourceCheckpointAccessor.maintainCheckpoints(connectionId, (tx, ids) =>
    tx.agentSourcePage.deleteMany({ where: { id: { in: ids } } })
  );
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
/**
 * An explicit decision to give up on the gap behind a recovery fence. Retained proof is never
 * deleted or rewritten: the reset starts a new epoch at the retained high water, beside the
 * old epoch's proof, and the next baseline records the then-current head in it.
 */
async function resetSource(projectId: string, connectionId: string) {
  return await ledgerTransaction(async (tx) => {
    const project = await tx.project.findUnique({ where: { id: projectId } });
    const owned = await tx.agentTrigger.findFirst({
      where: { connectionId, isConfigured: true, agentDefinition: { projectId } },
      select: { id: true },
    });
    if (!(project && owned)) {
      throw new ApplicationError('NOT_FOUND', 'Source not found.');
    }
    if (project.isArchived) {
      throw new ApplicationError('PRECONDITION_FAILED', 'Choose an active project.');
    }
    const connection = await tx.agentConnection.findUniqueOrThrow({
      where: { id: connectionId },
      include: { sourceState: true },
    });
    const state = connection.sourceState;
    const parsed = agentSourceHealthSchema.safeParse(state?.health);
    if (connection.provider === 'GITHUB' && state && parsed.data?.state === 'RECOVERY_REQUIRED') {
      const paused = await pauseTriggers(tx, { connectionId });
      await tx.agentSourceState.update({
        where: { connectionId },
        data: {
          epoch: { increment: 1 },
          epochStartSourceOrder: state.lastSourceOrder,
          cursor: Prisma.DbNull,
          isReady: false,
          health: health('DISCONNECTED', 'GITHUB_SOURCE_RESET'),
        },
      });
      return { connectionId, ...paused };
    }
    // A repeat before any fresh head was captured has nothing left to do. It must not pause
    // triggers the user enabled again in between.
    if (state && state.epoch > 0 && state.cursor === null) {
      return { connectionId, pausedTriggerCount: 0, cancelledRunCount: 0 };
    }
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Only a GitHub source that requires recovery can be reset.'
    );
  });
}

export const agentSourceAccessor = {
  resetSource,
  listTargets,
  getState,
  getBaseline,
  prepareBaseline,
  setFailure,
  resume,
  savePage,
  finalizeNextChunk,
  finalizeEventOrder,
  maintainCheckpoints,
};
