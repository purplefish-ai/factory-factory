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

  it('treats NEUTRAL and CANCELLED as non-blocking when a passing check exists', () => {
    const result = deriveCiStatusFromCheckRollup([
      { status: 'completed', conclusion: 'cancelled' },
      { status: 'completed', conclusion: 'neutral' },
      { status: 'completed', conclusion: 'success' },
    ]);

    expect(result).toBe(CIStatus.SUCCESS);
  });

  it('uses the latest GitHub Actions run per check identity before classifying', () => {
    const result = deriveCiStatusFromCheckRollup([
      {
        name: 'ci',
        workflowName: 'CI',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        detailsUrl: 'https://github.com/org/repo/actions/runs/100/job/1',
      },
      {
        name: 'ci',
        workflowName: 'CI',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        detailsUrl: 'https://github.com/org/repo/actions/runs/101/job/1',
      },
    ]);

    expect(result).toBe(CIStatus.SUCCESS);
  });

  it('keeps failures from distinct checks even when one rerun succeeded', () => {
    const result = deriveCiStatusFromCheckRollup([
      {
        name: 'commitlint',
        workflowName: 'CI',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        detailsUrl: 'https://github.com/org/repo/actions/runs/100/job/11',
      },
      {
        name: 'ci',
        workflowName: 'CI',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        detailsUrl: 'https://github.com/org/repo/actions/runs/100/job/22',
      },
      {
        name: 'ci',
        workflowName: 'CI',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        detailsUrl: 'https://github.com/org/repo/actions/runs/101/job/22',
      },
    ]);

    expect(result).toBe(CIStatus.FAILURE);
  });
});
