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

  it('treats ACTION_REQUIRED, ERROR, and TIMED_OUT as failing in visual derivation', () => {
    expect(
      deriveCiVisualStateFromChecks([{ conclusion: 'ACTION_REQUIRED', status: 'COMPLETED' }])
    ).toBe('FAILING');
    expect(deriveCiVisualStateFromChecks([{ state: 'ERROR' }])).toBe('FAILING');
    expect(deriveCiVisualStateFromChecks([{ conclusion: 'TIMED_OUT', status: 'COMPLETED' }])).toBe(
      'FAILING'
    );
  });

  it('returns RUNNING when checks are incomplete', () => {
    expect(deriveCiVisualStateFromChecks([{ conclusion: null, status: 'IN_PROGRESS' }])).toBe(
      'RUNNING'
    );
  });

  it('returns UNKNOWN when all checks are complete but non-success', () => {
    expect(
      deriveCiVisualStateFromChecks([
        { conclusion: 'NEUTRAL', status: 'COMPLETED' },
        { conclusion: 'CANCELLED', status: 'COMPLETED' },
      ])
    ).toBe('UNKNOWN');
  });

  it('derives canonical CI status from check rollup', () => {
    expect(
      deriveCiStatusFromCheckRollup([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'FAILURE' },
      ])
    ).toBe('FAILURE');

    expect(deriveCiStatusFromCheckRollup([{ status: 'COMPLETED', conclusion: 'TIMED_OUT' }])).toBe(
      'FAILURE'
    );

    expect(deriveCiStatusFromCheckRollup([{ status: 'IN_PROGRESS' }])).toBe('PENDING');

    expect(
      deriveCiStatusFromCheckRollup([
        { status: 'COMPLETED', conclusion: 'NEUTRAL' },
        { status: 'COMPLETED', conclusion: 'CANCELLED' },
      ])
    ).toBe('UNKNOWN');
  });

  it('handles lowercase status and conclusion values', () => {
    expect(deriveCiStatusFromCheckRollup([{ status: 'in_progress' }])).toBe('PENDING');

    expect(deriveCiStatusFromCheckRollup([{ status: 'completed', conclusion: 'failure' }])).toBe(
      'FAILURE'
    );
  });

  it('derives UNKNOWN for unrecognized completed outcomes', () => {
    expect(
      deriveCiStatusFromCheckRollup([{ status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' }])
    ).toBe('UNKNOWN');
  });
});
