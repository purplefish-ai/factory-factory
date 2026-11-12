import { expect, it } from 'vitest';
import { describeEventReason } from './event-history-reasons';

it('names pause, edit and source reset as causes of a stale-revision cancellation', () => {
  const phrase = describeEventReason('STALE_REVISION');
  expect(phrase).toContain('paused');
  expect(phrase).toContain('edited');
  expect(phrase).toContain('source was reset');
});

it.each([
  'SEMANTIC_FILTER_MATCH',
  'SEMANTIC_FILTER_SKIP',
  'SEMANTIC_FILTER_UNCERTAIN',
  'SEMANTIC_FILTER_PROVIDER_UNPROVEN',
  'SEMANTIC_FILTER_TOO_LONG',
  'SEMANTIC_FILTER_UNAVAILABLE',
  'SEMANTIC_FILTER_MALFORMED',
  'SEMANTIC_FILTER_TIMEOUT',
  'SEMANTIC_FILTER_RATE_LIMITED',
  'SEMANTIC_FILTER_FAILED',
])('describes the natural-language filter outcome %s', (code) => {
  const phrase = describeEventReason(code);
  expect(phrase).not.toBe('Unrecognized reason.');
  expect(phrase).not.toMatch(/available yet/);
});
