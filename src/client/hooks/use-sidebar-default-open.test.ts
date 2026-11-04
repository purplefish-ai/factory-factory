import { describe, expect, it } from 'vitest';
import {
  clearTransientOverrideOnCategoryChange,
  getRouteCategory,
} from './use-sidebar-default-open';

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

describe('getRouteCategory', () => {
  it.each([
    ['/projects/a/workspaces', 'board'],
    ['/projects/a/workspaces/', 'board'],
    // Matches the Board nav item, which treats project URLs case-insensitively.
    ['/PROJECTS/a/WORKSPACES', 'board'],
    ['/projects/a/workspaces/ws-1', 'workspace_detail'],
    ['/Projects/a/Workspaces/ws-1', 'workspace_detail'],
    ['/projects/a/agents', 'default'],
  ] as const)('classifies %s as %s', (pathname, category) => {
    expect(getRouteCategory(pathname)).toBe(category);
  });
});
