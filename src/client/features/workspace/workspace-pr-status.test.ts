import { describe, expect, it } from 'vitest';
import { getPrChipStatus, getPrCiState } from './workspace-pr-status';

const open = { state: 'OPEN', ciStatus: 'SUCCESS', hasMergeConflict: false } as const;

describe('PR chip status', () => {
  it.each([
    [{ ...open }, 'success', 'CI Passing'],
    [{ ...open, ciStatus: 'PENDING' }, 'waiting', 'CI Running'],
    [{ ...open, ciStatus: 'FAILURE' }, 'danger', 'CI Failing'],
    [{ ...open, ciStatus: 'UNKNOWN' }, 'success', 'Open'],
    [{ ...open, state: 'DRAFT' }, 'neutral', 'Draft'],
    [{ ...open, state: 'APPROVED' }, 'success', 'Approved'],
    [{ ...open, state: 'CHANGES_REQUESTED' }, 'danger', 'Changes requested'],
    [{ ...open, state: 'MERGED', ciStatus: 'FAILURE' }, 'merged', 'Merged'],
    [{ ...open, state: 'CLOSED' }, 'danger', 'Closed'],
    [{ ...open, hasMergeConflict: true }, 'attention', 'Conflicts'],
    [{ ...open, state: 'NONE' }, 'neutral', 'Syncing'],
  ] as const)('%o shows %s "%s"', (pr, tone, label) => {
    expect(getPrChipStatus(pr)).toEqual({ tone, label });
  });

  it('never hides a failing check or requested change behind a better state', () => {
    expect(getPrChipStatus({ ...open, state: 'APPROVED', ciStatus: 'FAILURE' }).label).toBe(
      'CI Failing'
    );
    expect(
      getPrChipStatus({ ...open, state: 'CHANGES_REQUESTED', ciStatus: 'PENDING' }).label
    ).toBe('Changes requested');
    expect(getPrChipStatus({ ...open, state: 'APPROVED', ciStatus: 'PENDING' }).label).toBe(
      'CI Running'
    );
  });

  it('ranks terminal states over conflicts and conflicts over CI', () => {
    expect(getPrCiState({ ...open, hasMergeConflict: true, ciStatus: 'FAILURE' })).toBe('CONFLICT');
    expect(getPrCiState({ ...open, state: 'MERGED', hasMergeConflict: true })).toBe('MERGED');
  });
});
