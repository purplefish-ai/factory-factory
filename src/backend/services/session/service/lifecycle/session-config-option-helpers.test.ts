import { describe, expect, it } from 'vitest';
import { getSelectOptions } from './session-config-option-helpers';

describe('getSelectOptions', () => {
  it('returns no select choices for a boolean config option', () => {
    expect(
      getSelectOptions({ id: 'fast', name: 'Fast', type: 'boolean', currentValue: false })
    ).toEqual([]);
  });
});
