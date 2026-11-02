import { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
import { agentSourcePageEvidenceSchema } from '@/shared/agent-source-state';
import type { DurableRecovery } from '@/shared/schemas/durable-recovery.schema';

type Checkpoint = DurableRecovery['agentSourceCheckpoint'][number];
type Head = DurableRecovery['agentSourceHead'][number];
type Claims = Map<string, number>;
const key = (connection: string, identity: string | null) => JSON.stringify([connection, identity]);
function invalid(): never {
  throw new ApplicationError('INVALID_INPUT', 'Contradictory or incomplete recovery source proof');
}
function claim(claims: Claims, connection: string, identity: string | null, order: number | null) {
  if (order === null) {
    return;
  }
  const id = key(connection, identity);
  const previous = claims.get(id);
  if (
    !Number.isSafeInteger(order) ||
    order < 0 ||
    (identity === null && order !== 0) ||
    (previous !== undefined && previous !== order)
  ) {
    invalid();
  }
  claims.set(id, order);
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
  for (const checkpoint of data.agentSourceCheckpoint) {
    const state = states.get(checkpoint.connectionId);
    if (!state) {
      invalid();
    }
    assertCursorFence(checkpoint, state.authorityRevision);
  }
  collectCheckpointClaims(authoritative, states, markers, headsByScan, claims);
  collectRetainedClaims(data, headsByScan, claims);
  for (const checkpoint of authoritative) {
    if (checkpoint.previousBoundaryEventId === null) {
      if (checkpoint.initialSourceOrder !== 0) {
        invalid();
      }
    } else if (
      claims.get(key(checkpoint.connectionId, checkpoint.previousBoundaryEventId)) !==
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
  claims: Claims
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
      marker.head !== checkpoint.headEventId
    ) {
      invalid();
    }
    for (const head of heads) {
      claim(
        claims,
        checkpoint.connectionId,
        head.providerEventId,
        checkpoint.sourceOrder - head.precedingEventCount
      );
    }
  }
}
