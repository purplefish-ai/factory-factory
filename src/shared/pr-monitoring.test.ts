import { expect, it } from 'vitest';
import {
  canResumePRMonitoring,
  isPRDeliveryBlocked,
  PR_DELIVERY_BLOCKED_PAUSE_REASON,
  prPauseReasonSchema,
} from './pr-monitoring';

it('gives every pause reason delivery writes an exit through resume', () => {
  expect(prPauseReasonSchema.options).toEqual([
    'USER_STOPPED',
    'SESSION_FAILED',
    'RESUME_FAILED',
    'DELIVERY_FAILED',
    'RECEIPT_UNAVAILABLE',
    'INVALID_EVENT',
  ]);
  for (const reason of prPauseReasonSchema.options) {
    expect(canResumePRMonitoring(reason)).toBe(true);
  }
  // These end elsewhere: the cutover completes at startup, and the user discards a blocked delivery.
  for (const reason of [
    null,
    undefined,
    '',
    'LEGACY_FIXER',
    'LEGACY_FIXER_USER_STOPPED',
    PR_DELIVERY_BLOCKED_PAUSE_REASON,
    'UNKNOWN',
  ]) {
    expect(canResumePRMonitoring(reason)).toBe(false);
  }
});

it('recognizes only the projected blocked delivery reason as blocked', () => {
  expect(isPRDeliveryBlocked(PR_DELIVERY_BLOCKED_PAUSE_REASON)).toBe(true);
  for (const reason of [null, undefined, 'DELIVERY_FAILED', 'USER_STOPPED']) {
    expect(isPRDeliveryBlocked(reason)).toBe(false);
  }
});
