import { describe, expect, it } from 'vitest';
import { snapshotFieldPolicy, snapshotInputFields } from '@/test-utils/workspace-snapshot-contract';
import {
  workspaceProjectionPolicy,
  snapshotRequiredFields,
  snapshotDriftFields,
  snapshotFieldGroups,
} from './workspace-projection-fields';

describe('workspace projection field policy', () => {
  it('classifies every raw field against independent contract expectations', () => {
    expect(workspaceProjectionPolicy).toEqual(snapshotFieldPolicy);
    expect(snapshotRequiredFields.slice().sort()).toEqual(
      snapshotInputFields.filter((field) => snapshotFieldPolicy[field].required).sort()
    );
    expect(snapshotDriftFields.map(({ field }) => field).sort()).toEqual(
      snapshotInputFields
        .filter((field) => typeof snapshotFieldPolicy[field].drift === 'string')
        .sort()
    );
    for (const { group, fields } of snapshotFieldGroups) {
      expect(fields.slice().sort()).toEqual(
        snapshotInputFields.filter((field) => snapshotFieldPolicy[field].group === group).sort()
      );
    }
  });
  it('keeps selected facts out of independent clocks and hydration', () => {
    expect(workspaceProjectionPolicy).not.toHaveProperty('selectedPr');
    expect(workspaceProjectionPolicy).not.toHaveProperty('selectedPrId');
  });
});
