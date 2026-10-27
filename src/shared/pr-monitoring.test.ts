import { expect, it } from 'vitest';
import { canResumePRMonitoring } from './pr-monitoring';

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
    'UNKNOWN',
  ]) {
    expect(canResumePRMonitoring(reason)).toBe(false);
  }
});
