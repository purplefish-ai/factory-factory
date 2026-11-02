import { expect, it, vi } from 'vitest';
import type { DurableRecovery } from '@/shared/schemas/durable-recovery.schema';
import { validRecoveryVerification } from './agent-recovery-source-proof-verification';

type Page = DurableRecovery['agentSourcePage'][number];
function retainedSuffix(headCount: number, repeatedIds: string[], corrupt: boolean) {
  const firstOrdinal = 1_000_000_000;
  const heads = Array.from({ length: headCount }, (_, position) => ({
    connectionId: 'source',
    scanId: 'scan',
    providerEventId: `control-${position}`,
    position,
    precedingEventCount: 0,
  }));
  const pages: Page[] = [];
  function page(ids: string[], requestPage: number, nextPage: number | null) {
    pages.push({
      id: `page-${pages.length}`,
      connectionId: 'source',
      scanId: 'scan',
      ordinal: firstOrdinal + pages.length,
      phase: 'VERIFY',
      requestPage,
      nextPage,
      sourceOrder: null,
      evidence: { ids, entries: [] },
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  }
  for (let repeat = 0; repeat < 200; repeat++) {
    const requestPage = repeatedIds.includes('unseen-prefix') ? repeat + 1 : 1;
    page(repeatedIds, requestPage, requestPage + 1);
  }
  for (let offset = 0; offset < headCount; offset += 100) {
    const ids = heads.slice(offset, offset + 100).map((head) => head.providerEventId);
    if (corrupt && offset + 100 >= headCount) {
      ids[ids.length - 1] = 'control-0';
    }
    const requestPage = offset / 100 + (repeatedIds.includes('unseen-prefix') ? 201 : 1);
    page(ids, requestPage, offset + 100 >= headCount ? null : requestPage + 1);
  }
  pages.push({
    id: 'marker',
    connectionId: 'source',
    scanId: 'scan',
    ordinal: firstOrdinal + pages.length,
    phase: 'FINALIZED',
    requestPage: pages.at(-1)!.requestPage,
    nextPage: null,
    sourceOrder: 0,
    evidence: { ids: ['control-0'], entries: [] },
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const checkpoint: DurableRecovery['agentSourceCheckpoint'][number] = {
    connectionId: 'source',
    scanId: 'scan',
    status: 'COMPLETE',
    nextOrdinal: firstOrdinal + pages.length,
    entryCount: headCount,
    executableCount: 0,
    verifiedCount: headCount,
    verification: null,
    headEventId: 'control-0',
    boundaryKnown: true,
    previousBoundaryEventId: null,
    initialSourceOrder: 0,
    sourceOrder: 0,
    validationCursor: null,
  };
  return { checkpoint, pages, heads };
}

it.each([
  { headCount: 3000, unknown: false, corrupt: false },
  { headCount: 12_000, unknown: false, corrupt: false },
  { headCount: 3000, unknown: false, corrupt: true },
  { headCount: 12_000, unknown: false, corrupt: true },
  { headCount: 12_000, unknown: true, corrupt: true },
])(
  'bounds compacted-prefix replay work to retained evidence: $headCount heads unknown=$unknown corrupt=$corrupt',
  ({ headCount, unknown, corrupt }) => {
    const repeatedIds = unknown
      ? ['unseen-prefix']
      : Array.from({ length: 10 }, (_, index) => `control-${index}`);
    const fixture = retainedSuffix(headCount, repeatedIds, corrupt);
    const original = Map.prototype.get;
    let lookups = 0;
    const spy = vi.spyOn(Map.prototype, 'get').mockImplementation(function (
      this: Map<unknown, unknown>,
      key: unknown
    ) {
      if (typeof key === 'string' && key.startsWith('control-')) {
        lookups++;
      }
      return original.call(this, key);
    });
    let result: boolean;
    try {
      result = validRecoveryVerification(fixture.checkpoint, fixture.pages, fixture.heads);
    } finally {
      spy.mockRestore();
    }
    expect(result).toBe(!corrupt);
    const retainedIds = 200 * repeatedIds.length + headCount;
    expect(lookups).toBeGreaterThanOrEqual(headCount);
    // A forged billion-page prefix never enumerates its offsets. Repeated lower
    // heads and discarded unknown pages cannot keep headCount states alive.
    expect(lookups).toBeLessThan(retainedIds * 250);
  }
);

it('retains a reachable erased zero saved count after positive progress on a later provider page', () => {
  const fixture = retainedSuffix(100, ['unseen-prefix'], false);
  const sample = fixture.pages[0]!;
  fixture.pages = [
    {
      ...sample,
      requestPage: 8,
      nextPage: 9,
      evidence: {
        ids: fixture.heads.slice(0, 11).map((head) => head.providerEventId),
        entries: [],
      },
    },
    {
      ...sample,
      id: 'complete',
      ordinal: sample.ordinal + 1,
      requestPage: 7,
      nextPage: null,
      evidence: { ids: fixture.heads.map((head) => head.providerEventId), entries: [] },
    },
    {
      ...sample,
      id: 'marker',
      ordinal: sample.ordinal + 2,
      phase: 'FINALIZED',
      requestPage: 7,
      nextPage: null,
      sourceOrder: 0,
      evidence: { ids: ['control-0'], entries: [] },
    },
  ];
  fixture.checkpoint.nextOrdinal = sample.ordinal + 3;
  expect(validRecoveryVerification(fixture.checkpoint, fixture.pages, fixture.heads)).toBe(true);
});

it.each([false, true])(
  'requires the original saved resume page when an erased one-head interval cannot have advanced: contradictory=$0',
  (contradictory) => {
    const fixture = retainedSuffix(100, ['unseen-prefix'], false);
    fixture.heads = fixture.heads.slice(0, 1);
    fixture.checkpoint.entryCount = 1;
    fixture.checkpoint.verifiedCount = 1;
    const sample = fixture.pages[0]!;
    fixture.pages = [
      {
        ...sample,
        requestPage: 5,
        nextPage: 6,
        evidence: { ids: ['unseen-prefix'], entries: [] },
      },
      {
        ...sample,
        id: 'resume',
        ordinal: sample.ordinal + 1,
        requestPage: contradictory ? 7 : 6,
        nextPage: null,
        evidence: { ids: ['control-0'], entries: [] },
      },
      {
        ...sample,
        id: 'marker',
        ordinal: sample.ordinal + 2,
        phase: 'FINALIZED',
        requestPage: contradictory ? 7 : 6,
        nextPage: null,
        sourceOrder: 0,
        evidence: { ids: ['control-0'], entries: [] },
      },
    ];
    fixture.checkpoint.nextOrdinal = sample.ordinal + 3;
    expect(validRecoveryVerification(fixture.checkpoint, fixture.pages, fixture.heads)).toBe(
      !contradictory
    );
  }
);

it('counts the previous boundary identity in the minimum erased CAPTURE page capacity', () => {
  const fixture = retainedSuffix(100, ['unseen-prefix'], false);
  fixture.checkpoint.previousBoundaryEventId = 'boundary';
  fixture.checkpoint.verifiedCount = 101;
  fixture.checkpoint.nextOrdinal = 4;
  const sample = fixture.pages[0]!;
  fixture.pages = [
    {
      ...sample,
      ordinal: 2,
      requestPage: 1,
      nextPage: null,
      evidence: { ids: ['boundary'], entries: [] },
    },
    {
      ...sample,
      id: 'marker',
      ordinal: 3,
      phase: 'FINALIZED',
      requestPage: 1,
      nextPage: null,
      sourceOrder: 0,
      evidence: { ids: ['control-0'], entries: [] },
    },
  ];
  // The two erased pages must both be CAPTURE to fit100 heads plus boundary.
  // They cannot also contain the claimed100-head VERIFY prefix.
  expect(validRecoveryVerification(fixture.checkpoint, fixture.pages, fixture.heads)).toBe(false);
});

it.each([false, true])(
  'bounds the erased saved overlap to its last advancing page: canonicalRewind=$0',
  (canonicalRewind) => {
    const fixture = retainedSuffix(1400, ['unseen-prefix'], false);
    const sample = fixture.pages[0]!;
    fixture.pages = [
      {
        ...sample,
        requestPage: 20,
        nextPage: 21,
        evidence: { ids: ['control-1000'], entries: [] },
      },
      {
        ...sample,
        id: 'shifted',
        ordinal: sample.ordinal + 1,
        requestPage: 19,
        nextPage: 20,
        evidence: {
          ids: ['unseen-prefix', ...fixture.heads.slice(0, 99).map((head) => head.providerEventId)],
          entries: [],
        },
      },
    ];
    const start = canonicalRewind ? 0 : 99;
    for (let offset = start; offset < fixture.heads.length; offset += 100) {
      fixture.pages.push({
        ...sample,
        id: `tail-${offset}`,
        ordinal: sample.ordinal + fixture.pages.length,
        requestPage: (offset - start) / 100 + (canonicalRewind ? 1 : 20),
        nextPage:
          offset + 100 < fixture.heads.length
            ? (offset - start) / 100 + (canonicalRewind ? 2 : 21)
            : null,
        evidence: {
          ids: fixture.heads.slice(offset, offset + 100).map((head) => head.providerEventId),
          entries: [],
        },
      });
    }
    fixture.pages.push({
      ...sample,
      id: 'marker',
      ordinal: sample.ordinal + fixture.pages.length,
      phase: 'FINALIZED',
      requestPage: fixture.pages.at(-1)!.requestPage,
      nextPage: null,
      sourceOrder: 0,
      evidence: { ids: ['control-0'], entries: [] },
    });
    fixture.checkpoint.nextOrdinal = sample.ordinal + fixture.pages.length;
    // After observing1000, a surviving hidden count is >1000 and its saved
    // count is >=901. Unknown overlap must discard this page and restart at1.
    expect(validRecoveryVerification(fixture.checkpoint, fixture.pages, fixture.heads)).toBe(
      canonicalRewind
    );
  }
);

it.each(['tail-jump', 'arbitrary-saved-page', 'canonical-replay'] as const)(
  'requires the exact saved pair when only one verification observation was erased: %s',
  (mode) => {
    const fixture = retainedSuffix(101, ['unseen-prefix'], false);
    const sample = fixture.pages[0]!;
    fixture.pages = [
      {
        ...sample,
        ordinal: 3,
        requestPage: 2,
        nextPage: 3,
        evidence: { ids: ['control-99', 'control-98'], entries: [] },
      },
    ];
    if (mode === 'tail-jump') {
      fixture.pages.push({
        ...sample,
        id: 'jump',
        ordinal: 4,
        requestPage: 7,
        nextPage: null,
        evidence: { ids: ['control-100'], entries: [] },
      });
    } else {
      for (let offset = 0; offset < 101; offset += 100) {
        const requestPage = offset / 100 + (mode === 'canonical-replay' ? 1 : 2);
        fixture.pages.push({
          ...sample,
          id: `resume-${offset}`,
          ordinal: 3 + fixture.pages.length,
          requestPage,
          nextPage: offset === 0 ? requestPage + 1 : null,
          evidence: {
            ids: fixture.heads.slice(offset, offset + 100).map((head) => head.providerEventId),
            entries: [],
          },
        });
      }
    }
    fixture.pages.push({
      ...sample,
      id: 'marker',
      ordinal: 3 + fixture.pages.length,
      phase: 'FINALIZED',
      requestPage: fixture.pages.at(-1)!.requestPage,
      nextPage: null,
      sourceOrder: 0,
      evidence: { ids: ['control-0'], entries: [] },
    });
    fixture.checkpoint.nextOrdinal = 3 + fixture.pages.length;
    expect(validRecoveryVerification(fixture.checkpoint, fixture.pages, fixture.heads)).toBe(
      mode === 'canonical-replay'
    );
  }
);

it('preserves an erased saved count equal to current count after a real unfinished resume', () => {
  const fixture = retainedSuffix(201, ['unseen-prefix'], false);
  const sample = fixture.pages[0]!;
  fixture.pages = [
    {
      ...sample,
      ordinal: 5,
      requestPage: 2,
      nextPage: 3,
      evidence: { ids: ['control-99'], entries: [] },
    },
    {
      ...sample,
      id: 'resume',
      ordinal: 6,
      requestPage: 2,
      nextPage: 3,
      evidence: {
        ids: fixture.heads.slice(100, 200).map((head) => head.providerEventId),
        entries: [],
      },
    },
    {
      ...sample,
      id: 'tail',
      ordinal: 7,
      requestPage: 3,
      nextPage: null,
      evidence: { ids: ['control-200'], entries: [] },
    },
    {
      ...sample,
      id: 'marker',
      ordinal: 8,
      phase: 'FINALIZED',
      requestPage: 3,
      nextPage: null,
      sourceOrder: 0,
      evidence: { ids: ['control-0'], entries: [] },
    },
  ];
  fixture.checkpoint.nextOrdinal = 9;
  // The two erased pages can advance0→100→200, then resume100 without
  // observing another page. Saved count100 equals current100 legitimately.
  expect(validRecoveryVerification(fixture.checkpoint, fixture.pages, fixture.heads)).toBe(true);
});

it.each([1, 2])('bounds initial seeking progress by %s erased observations', (erased) => {
  const fixture = retainedSuffix(101, ['unseen-prefix'], false);
  const sample = fixture.pages[0]!;
  const first = 2 + erased;
  fixture.pages = [
    {
      ...sample,
      ordinal: first,
      requestPage: 2,
      nextPage: 3,
      evidence: { ids: ['unseen-prefix'], entries: [] },
    },
    {
      ...sample,
      id: 'replay',
      ordinal: first + 1,
      requestPage: 1,
      nextPage: 2,
      evidence: {
        ids: fixture.heads.slice(0, 100).map((head) => head.providerEventId),
        entries: [],
      },
    },
    {
      ...sample,
      id: 'tail',
      ordinal: first + 2,
      requestPage: 2,
      nextPage: null,
      evidence: { ids: ['control-100'], entries: [] },
    },
    {
      ...sample,
      id: 'marker',
      ordinal: first + 3,
      phase: 'FINALIZED',
      requestPage: 2,
      nextPage: null,
      sourceOrder: 0,
      evidence: { ids: ['control-0'], entries: [] },
    },
  ];
  fixture.checkpoint.nextOrdinal = first + 4;
  expect(validRecoveryVerification(fixture.checkpoint, fixture.pages, fixture.heads)).toBe(
    erased === 2
  );
});

it.each(['unvisited-page', 'count-before-page-one', 'canonical-replay'] as const)(
  'keeps erased saved count and page jointly reachable: %s',
  (mode) => {
    const fixture = retainedSuffix(101, ['unseen-prefix'], false);
    const sample = fixture.pages[0]!;
    fixture.pages = [
      {
        ...sample,
        ordinal: 4,
        requestPage: 3,
        nextPage: 4,
        evidence: { ids: ['control-99'], entries: [] },
      },
    ];
    if (mode === 'count-before-page-one') {
      fixture.pages.push({
        ...sample,
        id: 'jump',
        ordinal: 5,
        requestPage: 1,
        nextPage: null,
        evidence: { ids: ['control-100'], entries: [] },
      });
    } else {
      const start = mode === 'canonical-replay' ? 1 : 7;
      fixture.pages.push(
        {
          ...sample,
          id: 'replay',
          ordinal: 5,
          requestPage: start,
          nextPage: start + 1,
          evidence: {
            ids: fixture.heads.slice(0, 100).map((head) => head.providerEventId),
            entries: [],
          },
        },
        {
          ...sample,
          id: 'tail',
          ordinal: 6,
          requestPage: start + 1,
          nextPage: null,
          evidence: { ids: ['control-100'], entries: [] },
        }
      );
    }
    fixture.pages.push({
      ...sample,
      id: 'marker',
      ordinal: 4 + fixture.pages.length,
      phase: 'FINALIZED',
      requestPage: fixture.pages.at(-1)!.requestPage,
      nextPage: null,
      sourceOrder: 0,
      evidence: { ids: ['control-0'], entries: [] },
    });
    fixture.checkpoint.nextOrdinal = 4 + fixture.pages.length;
    expect(validRecoveryVerification(fixture.checkpoint, fixture.pages, fixture.heads)).toBe(
      mode === 'canonical-replay'
    );
  }
);

it('rejects duplicate retained provider identities even when an already-verified prefix would ignore them', () => {
  const fixture = retainedSuffix(101, ['unseen-prefix'], false);
  const sample = fixture.pages[0]!;
  fixture.pages = [
    {
      ...sample,
      ordinal: 3,
      requestPage: 2,
      nextPage: 3,
      evidence: { ids: ['control-99', 'control-99'], entries: [] },
    },
    {
      ...sample,
      id: 'replay',
      ordinal: 4,
      requestPage: 1,
      nextPage: 2,
      evidence: {
        ids: fixture.heads.slice(0, 100).map((head) => head.providerEventId),
        entries: [],
      },
    },
    {
      ...sample,
      id: 'tail',
      ordinal: 5,
      requestPage: 2,
      nextPage: null,
      evidence: { ids: ['control-100'], entries: [] },
    },
    {
      ...sample,
      id: 'marker',
      ordinal: 6,
      phase: 'FINALIZED',
      requestPage: 2,
      nextPage: null,
      sourceOrder: 0,
      evidence: { ids: ['control-0'], entries: [] },
    },
  ];
  fixture.checkpoint.nextOrdinal = 7;
  expect(validRecoveryVerification(fixture.checkpoint, fixture.pages, fixture.heads)).toBe(false);
});
