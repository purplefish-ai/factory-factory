import { expect, it } from 'vitest';
import {
  canResumePRMonitoring,
  isPRDeliveryBlocked,
  PR_DELIVERY_BLOCKED_PAUSE_REASON,
} from './pr-monitoring';

it('allows only recoverable monitoring pauses to be resumed explicitly', () => {
  for (const reason of [
    'USER_STOPPED',
    'SESSION_FAILED',
    'RESUME_FAILED',
    'DELIVERY_FAILED',
    'RECEIPT_UNAVAILABLE',
  ]) {
    expect(canResumePRMonitoring(reason)).toBe(true);
  }
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
