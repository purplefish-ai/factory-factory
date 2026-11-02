import { expect, it } from 'vitest';
import { durableRecoverySchema } from '@/shared/schemas/durable-recovery.schema';
import { validateRecoverySourceProof } from './agent-recovery-source-proof';

function compactInterval() {
  const data = durableRecoverySchema.parse(
    Object.fromEntries(
      Object.keys(durableRecoverySchema.shape).map((name) => [
        name,
        name === 'jsonStorage' ? { version: 1, jsonNulls: [] } : [],
      ])
    )
  );
  const createdAt = '2026-01-01T00:00:00.000Z';
  data.agentSourceState.push({
    connectionId: 'source',
    authorityRevision: 20,
    lastSourceOrder: 6,
    isReady: true,
    cursor: null,
    health: null,
    lastObservedAt: null,
    updatedAt: createdAt,
  });
  data.agentSourceBaseline.push({
    id: 'B',
    connectionId: 'source',
    headEventId: 'B',
    afterHeadEventId: null,
    sourceOrder: 5,
    createdAt,
  });
  data.agentSourceCheckpoint.push({
    connectionId: 'source',
    scanId: 'scan',
    status: 'COMPLETE',
    nextOrdinal: 4,
    entryCount: 1,
    executableCount: 1,
    verifiedCount: 2,
    verification: null,
    headEventId: 'A',
    boundaryKnown: true,
    previousBoundaryEventId: 'B',
    initialSourceOrder: 5,
    sourceOrder: 6,
    validationCursor: {
      revision: 20,
      phase: 'BASELINES',
      scanId: 'zz',
      position: 999,
      baselineId: 'zz',
      headCount: 1,
    },
  });
  data.agentSourceHead.push({
    connectionId: 'source',
    scanId: 'scan',
    providerEventId: 'A',
    position: 0,
    precedingEventCount: 0,
  });
  data.agentSourcePage.push({
    id: 'marker',
    connectionId: 'source',
    scanId: 'scan',
    ordinal: 3,
    phase: 'FINALIZED',
    requestPage: 1,
    nextPage: null,
    sourceOrder: 6,
    evidence: { ids: ['A'], entries: [] },
    createdAt,
  });
  return data;
}
it('accepts internally consistent compact A6/B5 proof without full capture pages', () => {
  expect(() => validateRecoverySourceProof(compactInterval())).not.toThrow();
});
it('rejects a lone null-head ordinal9 beside valid A6/B5 proof without needing a null0 witness', () => {
  const data = compactInterval();
  data.agentSourceBaseline.push({
    id: 'empty',
    connectionId: 'source',
    headEventId: null,
    afterHeadEventId: null,
    sourceOrder: 9,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  expect(() => validateRecoverySourceProof(data)).toThrow(/source proof/i);
});
it('rejects validation progress whose future revision could become authoritative later', () => {
  const data = compactInterval();
  data.agentSourceCheckpoint[0]!.validationCursor = {
    revision: 21,
    phase: 'BASELINES',
    baselineId: 'zz',
    headCount: 1,
  };
  expect(() => validateRecoverySourceProof(data)).toThrow(/source proof/i);
});

it('rejects contradictory ordinal claims in unfinished checkpoint heads despite a forged current cursor', () => {
  const data = compactInterval();
  const original = data.agentSourceCheckpoint[0]!;
  original.status = 'INDEXED';
  data.agentSourceCheckpoint.push({
    ...original,
    scanId: 'unfinished',
    status: 'BUILDING',
    sourceOrder: 7,
  });
  data.agentSourceHead.push({ ...data.agentSourceHead[0]!, scanId: 'unfinished' });
  expect(() => validateRecoverySourceProof(data)).toThrow(/source proof/i);
});
it('rejects event ordinals inconsistent with the retained head even when the event payload expired', () => {
  const data = compactInterval();
  const timestamp = '2026-01-01T00:00:00.000Z';
  data.agentEvent.push({
    id: 'event',
    connectionId: 'source',
    providerEventId: 'A',
    sourceOrder: 7,
    payload: null,
    occurredAt: timestamp,
    observedAt: timestamp,
    payloadExpiresAt: timestamp,
    identityExpiresAt: timestamp,
    createdAt: timestamp,
  });
  expect(() => validateRecoverySourceProof(data)).toThrow(/source proof/i);
});
