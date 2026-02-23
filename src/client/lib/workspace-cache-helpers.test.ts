import { describe, expect, it } from 'vitest';
import {
  removeWorkspaceFromProjectSummaryCache,
  removeWorkspacesFromProjectSummaryCache,
} from './workspace-cache-helpers';

describe('workspace-cache-helpers', () => {
  it('removes one workspace from project summary cache', () => {
    const cache = {
      workspaces: [{ id: 'ws-1' }, { id: 'ws-2' }],
      reviewCount: 4,
    };

    const updated = removeWorkspaceFromProjectSummaryCache(cache, 'ws-1');

    expect(updated).toEqual({
      workspaces: [{ id: 'ws-2' }],
      reviewCount: 4,
    });
  });

  it('returns cache unchanged when workspace id is missing', () => {
    const cache = {
      workspaces: [{ id: 'ws-1' }],
      reviewCount: 2,
    };

    const updated = removeWorkspaceFromProjectSummaryCache(cache, 'ws-404');

    expect(updated).toBe(cache);
  });

  it('removes multiple workspaces from project summary cache', () => {
    const cache = {
      workspaces: [{ id: 'ws-1' }, { id: 'ws-2' }, { id: 'ws-3' }],
      reviewCount: 1,
    };

    const updated = removeWorkspacesFromProjectSummaryCache(cache, ['ws-1', 'ws-3']);

    expect(updated).toEqual({
      workspaces: [{ id: 'ws-2' }],
      reviewCount: 1,
    });
  });
});
