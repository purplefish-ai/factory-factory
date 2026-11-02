import { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
import {
  agentGithubCursorSchema,
  agentSourcePageEvidenceSchema,
  type AgentSourceScan,
} from '@/shared/agent-source-state';
import type { DurableRecovery } from '@/shared/schemas/durable-recovery.schema';
import { validRecoveryVerification } from './agent-recovery-source-proof-verification';

type Checkpoint = DurableRecovery['agentSourceCheckpoint'][number];
type Head = DurableRecovery['agentSourceHead'][number];
type Claims = Map<string, Map<string | null, number>>;
const key = (connection: string, identity: string | null) => JSON.stringify([connection, identity]);
function invalid(): never {
  throw new ApplicationError('INVALID_INPUT', 'Contradictory or incomplete recovery source proof');
}
function claim(claims: Claims, connection: string, identity: string | null, order: number | null) {
  if (order === null) {
    return;
  }
  const sourceClaims = claims.get(connection) ?? new Map<string | null, number>();
  const previous = sourceClaims.get(identity);
  if (
    !Number.isSafeInteger(order) ||
    order < 0 ||
    (identity === null && order !== 0) ||
    (previous !== undefined && previous !== order)
  ) {
    invalid();
  }
  sourceClaims.set(identity, order);
  claims.set(connection, sourceClaims);
}
function checkpointMetadata(checkpoint: Checkpoint, heads: Head[]) {
  if (
    checkpoint.sourceOrder === null ||
    checkpoint.initialSourceOrder === null ||
    !checkpoint.boundaryKnown ||
    checkpoint.sourceOrder - checkpoint.executableCount !== checkpoint.initialSourceOrder ||
    checkpoint.initialSourceOrder < 0 ||
    checkpoint.executableCount < 0 ||
    checkpoint.entryCount !== heads.length ||
    checkpoint.verifiedCount !== heads.length + (checkpoint.previousBoundaryEventId ? 1 : 0) ||
    checkpoint.headEventId !== (heads[0]?.providerEventId ?? null)
  ) {
    invalid();
  }
}
function checkpointHeads(checkpoint: Checkpoint, heads: Head[]) {
  checkpointMetadata(checkpoint, heads);
  let prior = 0;
  const identities = new Set<string>();
  for (const [position, head] of heads.entries()) {
    if (
      head.position !== position ||
      identities.has(head.providerEventId) ||
      head.providerEventId === checkpoint.previousBoundaryEventId ||
      head.precedingEventCount < prior ||
      head.precedingEventCount > prior + (position === 0 ? 0 : 1)
    ) {
      invalid();
    }
    identities.add(head.providerEventId);
    prior = head.precedingEventCount;
  }
  if (
    checkpoint.executableCount < prior ||
    checkpoint.executableCount > prior + (heads.length ? 1 : 0)
  ) {
    invalid();
  }
}
function assertCursorFence(checkpoint: Checkpoint, revision: number) {
  const cursor = z.object({ revision: z.number().int() }).safeParse(checkpoint.validationCursor);
  // Old progress remains evidence. A future revision could become authoritative
  // after an unrelated mutation, so it is never accepted from an import file.
  if (cursor.success && cursor.data.revision > revision) {
    invalid();
  }
}

function groupPages(pages: DurableRecovery['agentSourcePage']) {
  const pagesByScan = new Map<string, DurableRecovery['agentSourcePage']>();
  for (const page of pages) {
    const id = key(page.connectionId, page.scanId);
    const retained = pagesByScan.get(id) ?? [];
    retained.push(page);
    pagesByScan.set(id, retained);
  }
  return pagesByScan;
}

/** Recompute internal ordinal consistency from retained facts, never from an
 * imported validation cursor or a claimed COMPLETE label. Full capture pages
 * may be compacted; permanent heads, baselines and final markers suffice.
 */
export function validateRecoverySourceProof(data: DurableRecovery): void {
  const states = new Map(data.agentSourceState.map((state) => [state.connectionId, state]));
  const claims: Claims = new Map();
  for (const baseline of data.agentSourceBaseline) {
    claim(claims, baseline.connectionId, baseline.headEventId, baseline.sourceOrder);
  }
  const markers = collectMarkers(data, claims);
  const headsByScan = new Map<string, Head[]>();
  for (const head of data.agentSourceHead) {
    const id = key(head.connectionId, head.scanId);
    const heads = headsByScan.get(id) ?? [];
    heads.push(head);
    headsByScan.set(id, heads);
  }
  const authoritative = data.agentSourceCheckpoint.filter((row) =>
    ['INDEXED', 'COMPLETE'].includes(row.status)
  );
  const pagesByScan = groupPages(data.agentSourcePage);
  for (const checkpoint of data.agentSourceCheckpoint) {
    const state = states.get(checkpoint.connectionId);
    if (!state) {
      invalid();
    }
    assertCursorFence(checkpoint, state.authorityRevision);
  }
  collectCheckpointClaims(authoritative, states, markers, headsByScan, pagesByScan);
  collectRetainedClaims(data, headsByScan, claims);
  collectCaptureClaims(data, markers, headsByScan, claims);
  assertRetainedHighwater(states, claims);
  assertCommittedCursorClaims(data, claims, pagesByScan);
  for (const checkpoint of authoritative) {
    if (checkpoint.previousBoundaryEventId === null) {
      if (checkpoint.initialSourceOrder !== 0) {
        invalid();
      }
    } else if (
      claims.get(checkpoint.connectionId)?.get(checkpoint.previousBoundaryEventId) !==
      checkpoint.initialSourceOrder
    ) {
      invalid();
    }
  }
}

function collectRetainedClaims(
  data: DurableRecovery,
  headsByScan: Map<string, Head[]>,
  claims: Claims
) {
  // Promotion consults every retained head with an ordinal, including unfinished
  // or invalid intervals. Imported cursors cannot hide contradictory claims.
  for (const checkpoint of data.agentSourceCheckpoint) {
    if (checkpoint.sourceOrder === null) {
      continue;
    }
    for (const head of headsByScan.get(key(checkpoint.connectionId, checkpoint.scanId)) ?? []) {
      claim(
        claims,
        checkpoint.connectionId,
        head.providerEventId,
        checkpoint.sourceOrder - head.precedingEventCount
      );
    }
  }
  for (const event of data.agentEvent) {
    claim(claims, event.connectionId, event.providerEventId, event.sourceOrder);
  }
}

function collectMarkers(data: DurableRecovery, claims: Claims) {
  const markers = new Map<string, { head: string | null; order: number | null }>();
  for (const page of data.agentSourcePage) {
    if (page.phase !== 'FINALIZED') {
      continue;
    }
    const parsed = agentSourcePageEvidenceSchema.safeParse(page.evidence);
    if (!parsed.success || parsed.data.entries.length || parsed.data.ids.length > 1) {
      invalid();
    }
    const head = parsed.data.ids[0] ?? null;
    const id = key(page.connectionId, page.scanId);
    const old = markers.get(id);
    if (old && (old.head !== head || old.order !== page.sourceOrder)) {
      invalid();
    }
    markers.set(id, { head, order: page.sourceOrder });
    claim(claims, page.connectionId, head, page.sourceOrder);
  }
  return markers;
}
function collectCheckpointClaims(
  authoritative: Checkpoint[],
  states: Map<string, DurableRecovery['agentSourceState'][number]>,
  markers: ReturnType<typeof collectMarkers>,
  headsByScan: Map<string, Head[]>,
  pagesByScan: Map<string, DurableRecovery['agentSourcePage']>
) {
  for (const checkpoint of authoritative) {
    const heads = (headsByScan.get(key(checkpoint.connectionId, checkpoint.scanId)) ?? []).sort(
      (a, b) => a.position - b.position
    );
    checkpointHeads(checkpoint, heads);
    const state = states.get(checkpoint.connectionId);
    const marker = markers.get(key(checkpoint.connectionId, checkpoint.scanId));
    if (
      !state ||
      checkpoint.sourceOrder === null ||
      checkpoint.sourceOrder > state.lastSourceOrder ||
      !marker ||
      marker.order !== checkpoint.sourceOrder ||
      marker.head !== checkpoint.headEventId ||
      !validRecoveryVerification(
        checkpoint,
        pagesByScan.get(key(checkpoint.connectionId, checkpoint.scanId)) ?? [],
        heads
      )
    ) {
      invalid();
    }
  }
}

function capturesByScan(data: DurableRecovery) {
  const captures = new Map<string, DurableRecovery['agentSourcePage']>();
  for (const page of data.agentSourcePage) {
    if (page.phase === 'CAPTURE') {
      const id = key(page.connectionId, page.scanId);
      const pages = captures.get(id) ?? [];
      pages.push(page);
      captures.set(id, pages);
    }
  }
  return captures;
}
function capturePageClaims(
  page: DurableRecovery['agentSourcePage'][number],
  heads: Map<string, Head>,
  offset: number | undefined,
  highwater: number,
  claims: Claims
) {
  const evidence = agentSourcePageEvidenceSchema.safeParse(page.evidence);
  if (!evidence.success) {
    invalid();
  }
  for (const entry of evidence.data.entries) {
    offset ??= heads.get(entry.providerEventId)?.precedingEventCount;
    if (offset === undefined) {
      invalid();
    }
    claim(claims, page.connectionId, entry.providerEventId, highwater - offset);
    if (entry.eventId) {
      offset++;
    }
    if (offset > highwater) {
      invalid();
    }
  }
  return offset;
}
function collectCaptureClaims(
  data: DurableRecovery,
  markers: ReturnType<typeof collectMarkers>,
  headsByScan: Map<string, Head[]>,
  claims: Claims
) {
  for (const [id, pages] of capturesByScan(data)) {
    const marker = markers.get(id);
    if (marker?.order == null) {
      continue;
    }
    pages.sort((a, b) => a.ordinal - b.ordinal);
    // Runtime entriesFor/orderForHead walk retained entries in capture order.
    // Complete checkpoints may have compacted a prefix: their permanent offset
    // anchors the retained suffix, rather than falsely restarting at highwater.
    const heads = new Map((headsByScan.get(id) ?? []).map((head) => [head.providerEventId, head]));
    let offset: number | undefined = pages[0]?.ordinal === 0 ? 0 : undefined;
    let previous: number | undefined;
    for (const page of pages) {
      if (previous !== undefined && page.ordinal !== previous + 1) {
        invalid();
      }
      previous = page.ordinal;
      offset = capturePageClaims(page, heads, offset, marker.order, claims);
    }
  }
}

function assertRetainedHighwater(
  states: Map<string, DurableRecovery['agentSourceState'][number]>,
  claims: Claims
) {
  for (const state of states.values()) {
    if (!Number.isSafeInteger(state.lastSourceOrder) || state.lastSourceOrder < 0) {
      invalid();
    }
  }
  // Finalization writes ordinals and this highwater in one ledger transaction.
  // Missing counters can initialize at zero, never below retained positive proof.
  // FINALIZE's highwater includes its partially finalized, not-yet-committed head.
  for (const [connectionId, orders] of claims) {
    const highwater = states.get(connectionId)?.lastSourceOrder ?? 0;
    for (const order of orders.values()) {
      if (order > highwater) {
        invalid();
      }
    }
  }
}

function assertCommittedCursorClaims(
  data: DurableRecovery,
  claims: Claims,
  pagesByScan: Map<string, DurableRecovery['agentSourcePage']>
) {
  const events = new Map(data.agentEvent.map((event) => [event.id, event]));
  for (const state of data.agentSourceState) {
    const cursor = agentGithubCursorSchema.safeParse(state.cursor);
    // Opaque legacy bytes cannot pass the runtime parser. The independent
    // highwater check also protects reset-capable falsy and empty cursors.
    if (!cursor.success) {
      continue;
    }
    const { scan, committedHeadEventId } = cursor.data;
    if (
      scan &&
      (scan.previousBoundaryEventId !== committedHeadEventId ||
        (scan.phase !== 'FINALIZE' && scan.finalizedCount !== 0))
    ) {
      invalid();
    }
    // Finalization advances highwater in chunks before committing the new head.
    const committedOrder =
      state.lastSourceOrder - (scan?.phase === 'FINALIZE' ? scan.finalizedCount : 0);
    const retainedOrder =
      committedHeadEventId === null ? 0 : claims.get(state.connectionId)?.get(committedHeadEventId);
    // Do not add the imported cursor as an independent checkpoint boundary witness.
    if (retainedOrder === undefined || retainedOrder !== committedOrder) {
      invalid();
    }
    assertFinalizedPrefix(events, pagesByScan, state.connectionId, scan, committedOrder);
  }
}

function assertFinalizedPrefix(
  events: Map<string, DurableRecovery['agentEvent'][number]>,
  pagesByScan: Map<string, DurableRecovery['agentSourcePage']>,
  connectionId: string,
  scan: AgentSourceScan | null,
  committedOrder: number
) {
  if (scan?.phase !== 'FINALIZE') {
    return;
  }
  // Active scans are excluded from compaction. Runtime finalization skips this
  // exact reversed executable prefix, so every skipped row needs stored proof.
  const pages = (pagesByScan.get(key(connectionId, scan.id)) ?? [])
    .filter((page) => page.phase === 'CAPTURE')
    .sort((a, b) => a.ordinal - b.ordinal);
  if (!pages.length || pages.some((page, position) => page.ordinal !== position)) {
    invalid();
  }
  const entries = pages.flatMap(
    (page) => agentSourcePageEvidenceSchema.parse(page.evidence).entries
  );
  if (entries[0]?.providerEventId !== scan.fixedHeadEventId) {
    invalid();
  }
  const executable = entries
    .slice()
    .reverse()
    .filter((entry) => entry.eventId !== null);
  if (scan.finalizedCount > executable.length) {
    invalid();
  }
  for (const [index, entry] of executable.entries()) {
    const event = entry.eventId === null ? undefined : events.get(entry.eventId);
    const expected = index < scan.finalizedCount ? committedOrder + index + 1 : null;
    if (
      !event ||
      event.connectionId !== connectionId ||
      event.providerEventId !== entry.providerEventId ||
      event.sourceOrder !== expected
    ) {
      invalid();
    }
  }
}
