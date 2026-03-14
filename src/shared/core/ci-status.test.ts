import { describe, expect, it } from 'vitest';
import { deriveCiStatusFromCheckRollup } from './ci-status';
import { CIStatus } from './enums';

describe('deriveCiStatusFromCheckRollup', () => {
  it('does not return SUCCESS when all checks are CANCELLED', () => {
    const result = deriveCiStatusFromCheckRollup([
      { status: 'COMPLETED', conclusion: 'CANCELLED' },
    ]);

    expect(result).toBe(CIStatus.UNKNOWN);
  });

  it('is case-insensitive for completed conclusions', () => {
    const result = deriveCiStatusFromCheckRollup([{ status: 'completed', conclusion: 'failure' }]);

    expect(result).toBe(CIStatus.FAILURE);
  });

  it('is case-insensitive for in-progress statuses', () => {
    const result = deriveCiStatusFromCheckRollup([{ status: 'in_progress' }]);

    expect(result).toBe(CIStatus.PENDING);
  });

  it('still allows SUCCESS when checks are SUCCESS or SKIPPED', () => {
    const result = deriveCiStatusFromCheckRollup([
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'skipped' },
    ]);

    expect(result).toBe(CIStatus.SUCCESS);
  });
});
