import { expect, it } from 'vitest';
import { describeEventReason } from './event-history-reasons';

it('names pause, edit and source reset as causes of a stale-revision cancellation', () => {
  const phrase = describeEventReason('STALE_REVISION');
  expect(phrase).toContain('paused');
  expect(phrase).toContain('edited');
  expect(phrase).toContain('source was reset');
});
