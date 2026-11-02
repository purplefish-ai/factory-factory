import { expect, it } from 'vitest';
import { CLOSED_PR_POLL_INTERVAL_MS, shouldPollPR } from './pr-polling';

const now = Date.parse('2026-11-02T12:00:00.000Z');
const initialized = { observation: {}, syncedAt: new Date(now) };
it.each(['NONE', 'DRAFT', 'OPEN', 'CHANGES_REQUESTED', 'APPROVED'])(
  'preserves ordinary polling for %s PRs',
  (state) => expect(shouldPollPR({ ...initialized, state }, now)).toBe(true)
);
it('stops initialized merged observations regardless of age', () => {
  expect(shouldPollPR({ ...initialized, state: 'MERGED', syncedAt: new Date(0) }, now)).toBe(false);
});
it.each(['MERGED', 'CLOSED'])(
  'initializes legacy %s snapshots before applying terminal policy',
  (state) => expect(shouldPollPR({ ...initialized, state, observation: null }, now)).toBe(true)
);
it('makes closed observations eligible at thirty minutes, and immediately after reopening', () => {
  const closed = { ...initialized, state: 'CLOSED' };
  expect(shouldPollPR(closed, now + CLOSED_PR_POLL_INTERVAL_MS - 1)).toBe(false);
  expect(shouldPollPR(closed, now + CLOSED_PR_POLL_INTERVAL_MS)).toBe(true);
  expect(shouldPollPR({ ...closed, state: 'OPEN' }, now)).toBe(true);
  expect(shouldPollPR({ ...closed, syncedAt: null }, now)).toBe(true);
});
