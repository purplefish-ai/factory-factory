import { describe, expect, it } from 'vitest';
import { clearTransientOverrideOnCategoryChange } from './use-sidebar-default-open';

describe('clearTransientOverrideOnCategoryChange', () => {
  it('clears board override when leaving board routes', () => {
    const overrides = { board: true, workspace_detail: true };
    expect(clearTransientOverrideOnCategoryChange(overrides, 'board', 'default')).toEqual({
      workspace_detail: true,
    });
  });

  it('keeps overrides when staying on board', () => {
    const overrides = { board: true };
    expect(clearTransientOverrideOnCategoryChange(overrides, 'board', 'board')).toEqual({
      board: true,
    });
  });

  it('keeps overrides when leaving non-transient routes', () => {
    const overrides = { default: false };
    expect(
      clearTransientOverrideOnCategoryChange(overrides, 'default', 'workspace_detail')
    ).toEqual({
      default: false,
    });
  });
});
