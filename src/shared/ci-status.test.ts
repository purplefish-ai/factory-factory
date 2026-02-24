import { describe, expect, it } from 'vitest';
import {
  deriveCiStatusFromCheckRollup,
  deriveCiVisualStateFromChecks,
  deriveCiVisualStateFromPrCiStatus,
} from './ci-status';

describe('ci-status', () => {
  it('derives from workspace pr ci status enum', () => {
    expect(deriveCiVisualStateFromPrCiStatus('SUCCESS')).toBe('PASSING');
    expect(deriveCiVisualStateFromPrCiStatus('FAILURE')).toBe('FAILING');
    expect(deriveCiVisualStateFromPrCiStatus('PENDING')).toBe('RUNNING');
    expect(deriveCiVisualStateFromPrCiStatus('UNKNOWN')).toBe('UNKNOWN');
  });

  it('derives NONE for missing checks', () => {
    expect(deriveCiVisualStateFromChecks(null)).toBe('NONE');
    expect(deriveCiVisualStateFromChecks([])).toBe('NONE');
  });

  it('prioritizes failing over pending', () => {
    expect(
      deriveCiVisualStateFromChecks([
        { conclusion: null, status: 'IN_PROGRESS' },
        { conclusion: 'FAILURE', status: 'COMPLETED' },
      ])
    ).toBe('FAILING');
  });

  it('treats ACTION_REQUIRED and ERROR as failing in visual derivation', () => {
    expect(
      deriveCiVisualStateFromChecks([{ conclusion: 'ACTION_REQUIRED', status: 'COMPLETED' }])
    ).toBe('FAILING');
    expect(deriveCiVisualStateFromChecks([{ state: 'ERROR' }])).toBe('FAILING');
  });

  it('returns RUNNING when checks are incomplete', () => {
    expect(deriveCiVisualStateFromChecks([{ conclusion: null, status: 'IN_PROGRESS' }])).toBe(
      'RUNNING'
    );
  });

  it('returns PASSING when all checks are complete and non-failing', () => {
    expect(
      deriveCiVisualStateFromChecks([
        { conclusion: 'SUCCESS', status: 'COMPLETED' },
        { conclusion: 'NEUTRAL', status: 'COMPLETED' },
        { conclusion: 'CANCELLED', status: 'COMPLETED' },
      ])
    ).toBe('PASSING');
  });

  it('derives canonical CI status from check rollup', () => {
    expect(
      deriveCiStatusFromCheckRollup([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'FAILURE' },
      ])
    ).toBe('FAILURE');

    expect(deriveCiStatusFromCheckRollup([{ status: 'IN_PROGRESS' }])).toBe('PENDING');

    expect(
      deriveCiStatusFromCheckRollup([
        { status: 'COMPLETED', conclusion: 'NEUTRAL' },
        { status: 'COMPLETED', conclusion: 'CANCELLED' },
      ])
    ).toBe('SUCCESS');
  });

  it('derives UNKNOWN for unrecognized completed outcomes', () => {
    expect(
      deriveCiStatusFromCheckRollup([{ status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' }])
    ).toBe('UNKNOWN');
  });
});
