import { expect, it } from 'vitest';
import { newScan, verifyPage } from './agent-source-scan';

it('rejects an unknown feed item between previously verified pages', () => {
  const scan = { ...newScan('H', 'B'), phase: 'VERIFY' as const, verifiedCount: 1 };
  expect(() =>
    verifyPage(
      scan,
      [
        { providerEventId: 'H', eventId: null },
        { providerEventId: 'tail', eventId: null },
      ],
      {
        events: [
          { providerEventId: 'missing-middle', payload: null },
          { providerEventId: 'tail', payload: null },
          { providerEventId: 'B', payload: null },
        ],
        nextPage: null,
      }
    )
  ).toThrow();
});

it('requires the verified empty-baseline interval to reach the actual feed end', () => {
  const scan = { ...newScan('H', null), phase: 'VERIFY' as const };
  expect(() =>
    verifyPage(scan, [{ providerEventId: 'H', eventId: null }], {
      events: [
        { providerEventId: 'H', payload: null },
        { providerEventId: 'uncaptured-tail', payload: null },
      ],
      nextPage: null,
    })
  ).toThrow();
});
