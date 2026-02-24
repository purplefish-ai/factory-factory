import { describe, expect, it } from 'vitest';
import {
  clearTransientOverrideOnCategoryChange,
  getRouteCategoryForPath,
} from './use-sidebar-default-open';

describe('getRouteCategoryForPath', () => {
  it('classifies workspace detail paths', () => {
    expect(getRouteCategoryForPath('/projects/alpha/workspaces/ws-1')).toBe('workspace_detail');
  });

  it('classifies board paths with and without trailing slash', () => {
    expect(getRouteCategoryForPath('/projects/alpha/workspaces')).toBe('board');
    expect(getRouteCategoryForPath('/projects/alpha/workspaces/')).toBe('board');
  });

  it('classifies settings and reviews as default routes', () => {
    expect(getRouteCategoryForPath('/admin')).toBe('default');
    expect(getRouteCategoryForPath('/reviews')).toBe('default');
  });
});

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
