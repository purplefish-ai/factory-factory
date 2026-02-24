import { describe, expect, it } from 'vitest';
import { shouldAutoCloseSidebarOnNavigation } from './app-sidebar';

describe('shouldAutoCloseSidebarOnNavigation', () => {
  it('returns true when navigating from a non-board route to workspaces board', () => {
    expect(shouldAutoCloseSidebarOnNavigation('/admin', '/projects/demo/workspaces')).toBe(true);
    expect(shouldAutoCloseSidebarOnNavigation('/reviews', '/projects/demo/workspaces/')).toBe(true);
    expect(
      shouldAutoCloseSidebarOnNavigation(
        '/projects/demo/workspaces/workspace-1',
        '/projects/demo/workspaces'
      )
    ).toBe(true);
  });

  it('returns false when navigating within the workspaces board', () => {
    expect(
      shouldAutoCloseSidebarOnNavigation('/projects/demo/workspaces', '/projects/demo/workspaces/')
    ).toBe(false);
  });

  it('returns false when not navigating to the workspaces board', () => {
    expect(shouldAutoCloseSidebarOnNavigation('/admin', '/reviews')).toBe(false);
    expect(
      shouldAutoCloseSidebarOnNavigation('/projects/demo/workspaces', '/projects/demo/workspaces/1')
    ).toBe(false);
    expect(
      shouldAutoCloseSidebarOnNavigation('/projects/demo/workspaces', '/projects/demo/workspaces')
    ).toBe(false);
  });
});
