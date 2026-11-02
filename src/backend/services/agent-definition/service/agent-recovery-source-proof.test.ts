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

it('rejects a checkpoint that uses its own captured head as its previous-boundary witness', () => {
  const data = compactInterval();
  const checkpoint = data.agentSourceCheckpoint[0]!;
  checkpoint.previousBoundaryEventId = 'A';
  checkpoint.initialSourceOrder = 6;
  checkpoint.executableCount = 0;
  data.agentSourceBaseline = [];
  expect(() => validateRecoverySourceProof(data)).toThrow(/source proof/i);
});

it('checks legacy finalized capture orders even without a checkpoint for that interval', () => {
  const data = compactInterval();
  const marker = data.agentSourcePage[0]!;
  data.agentSourcePage.push(
    {
      ...marker,
      id: 'legacy-capture',
      scanId: 'legacy',
      ordinal: 0,
      phase: 'CAPTURE',
      sourceOrder: null,
      evidence: {
        ids: ['C', 'A'],
        entries: [
          { providerEventId: 'C', eventId: 'old-event' },
          { providerEventId: 'A', eventId: null },
        ],
      },
    },
    {
      ...marker,
      id: 'legacy-marker',
      scanId: 'legacy',
      ordinal: 2,
      evidence: { ids: ['C'], entries: [] },
    }
  );
  expect(() => validateRecoverySourceProof(data)).toThrow(/source proof/i);
});
it('accepts a retained capture suffix after prefix-page compaction', () => {
  const data = compactInterval();
  data.agentSourceBaseline[0]!.sourceOrder = 4;
  Object.assign(data.agentSourceCheckpoint[0]!, {
    entryCount: 3,
    executableCount: 2,
    verifiedCount: 4,
    initialSourceOrder: 4,
  });
  data.agentSourceHead.push(
    { ...data.agentSourceHead[0]!, providerEventId: 'X', position: 1, precedingEventCount: 1 },
    { ...data.agentSourceHead[0]!, providerEventId: 'Y', position: 2, precedingEventCount: 1 }
  );
  data.agentSourcePage.push({
    ...data.agentSourcePage[0]!,
    id: 'suffix',
    ordinal: 1,
    phase: 'CAPTURE',
    sourceOrder: null,
    evidence: {
      ids: ['X', 'Y', 'B'],
      entries: [
        { providerEventId: 'X', eventId: null },
        { providerEventId: 'Y', eventId: 'event-Y' },
      ],
    },
  });
  expect(() => validateRecoverySourceProof(data)).not.toThrow();
});
it.each(['CAPTURE', 'VERIFY', 'FINALIZE'] as const)(
  'uses the committed boundary order for a %s cursor',
  (phase) => {
    const data = compactInterval();
    data.agentSourceState[0]!.lastSourceOrder = phase === 'FINALIZE' ? 1006 : 6;
    data.agentSourceState[0]!.cursor = {
      version: 1,
      provider: 'GITHUB',
      committedHeadEventId: 'A',
      scan: {
        id: 'next-scan',
        fixedHeadEventId: 'new-head',
        previousBoundaryEventId: 'A',
        phase,
        nextPage: 1,
        observationCount: 1,
        verifiedCount: 0,
        finalizedCount: phase === 'FINALIZE' ? 1000 : 0,
        resumePage: 1,
        resumeIds: [],
        overlapOffset: null,
        verifyResumeCount: 0,
        verifySeekingOverlap: false,
      },
    };
    expect(() => validateRecoverySourceProof(data)).not.toThrow();
    data.agentSourceState[0]!.lastSourceOrder++;
    expect(() => validateRecoverySourceProof(data)).toThrow(/source proof/i);
  }
);
