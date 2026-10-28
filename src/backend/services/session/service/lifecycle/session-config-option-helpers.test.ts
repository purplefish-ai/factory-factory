import { describe, expect, it } from 'vitest';
import {
  buildCodexConfigOptionsWithModelCatalog,
  getSelectOptions,
} from './session-config-option-helpers';

describe('getSelectOptions', () => {
  it('returns no select choices for a boolean config option', () => {
    expect(
      getSelectOptions({ id: 'fast', name: 'Fast', type: 'boolean', currentValue: false })
    ).toEqual([]);
  });
});

describe('catalog effort enrichment', () => {
  it.each([
    { current: 'medium', catalogDefault: null, selected: undefined },
    { current: '', catalogDefault: 'unsupported', selected: undefined },
    { current: 'medium', catalogDefault: 'high', selected: 'high' },
    { current: 'high', catalogDefault: 'low', selected: 'high' },
  ])(
    'projects native effort $current with catalog default $catalogDefault as $selected',
    ({ current, catalogDefault, selected }) => {
      const result = buildCodexConfigOptionsWithModelCatalog(
        [
          {
            id: 'reasoning_effort',
            category: 'thought_level',
            name: 'Effort',
            type: 'select',
            currentValue: current,
            options: [{ value: 'medium', name: 'Medium' }],
          },
        ],
        [
          {
            id: 'codex',
            displayName: 'Codex',
            defaultReasoningEffort: catalogDefault,
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
          },
        ],
        'codex'
      );
      expect(result.find((option) => option.id === 'reasoning_effort')?.currentValue).toBe(
        selected
      );
    }
  );
});
