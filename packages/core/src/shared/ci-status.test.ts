import { describe, expect, it } from 'vitest';
import { deriveCiVisualStateFromChecks, deriveCiVisualStateFromPrCiStatus } from './ci-status';

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

  it('returns RUNNING when checks are incomplete', () => {
    expect(deriveCiVisualStateFromChecks([{ conclusion: null, status: 'IN_PROGRESS' }])).toBe(
      'RUNNING'
    );
  });

  it('returns PASSING when all checks are complete and non-failing', () => {
    expect(deriveCiVisualStateFromChecks([{ conclusion: 'SUCCESS', status: 'COMPLETED' }])).toBe(
      'PASSING'
    );
  });
});
