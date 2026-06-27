import { describe, expect, it } from 'vitest';
import {
  removeWorkspaceFromProjectSummaryCache,
  removeWorkspacesFromProjectSummaryCache,
  restoreWorkspacesToListCache,
  restoreWorkspacesToProjectSummaryCache,
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

  it('restores only missing optimistically removed workspaces', () => {
    const previousCache = {
      workspaces: [
        { id: 'ws-1', name: 'Archived workspace' },
        { id: 'ws-2', name: 'Still current' },
      ],
      reviewCount: 4,
    };
    const currentCache = {
      workspaces: [{ id: 'ws-2', name: 'Still current' }],
      reviewCount: 2,
    };

    const updated = restoreWorkspacesToProjectSummaryCache(currentCache, previousCache, ['ws-1']);

    expect(updated).toEqual({
      workspaces: [
        { id: 'ws-1', name: 'Archived workspace' },
        { id: 'ws-2', name: 'Still current' },
      ],
      reviewCount: 2,
    });
  });

  it('restores the previous project summary cache when the current cache is missing', () => {
    const previousCache = {
      workspaces: [
        { id: 'ws-1', name: 'Archived workspace' },
        { id: 'ws-2', name: 'Still current' },
      ],
      reviewCount: 4,
    };

    const updated = restoreWorkspacesToProjectSummaryCache(undefined, previousCache, ['ws-1']);

    expect(updated).toBe(previousCache);
  });

  it('preserves concurrent updates to workspaces already in the cache', () => {
    const previousCache = {
      workspaces: [
        { id: 'ws-1', name: 'Archived workspace' },
        { id: 'ws-2', name: 'Old name' },
      ],
      reviewCount: 4,
    };
    const currentCache = {
      workspaces: [{ id: 'ws-2', name: 'Updated by snapshot' }],
      reviewCount: 1,
    };

    const updated = restoreWorkspacesToProjectSummaryCache(currentCache, previousCache, ['ws-1']);

    expect(updated).toEqual({
      workspaces: [
        { id: 'ws-1', name: 'Archived workspace' },
        { id: 'ws-2', name: 'Updated by snapshot' },
      ],
      reviewCount: 1,
    });
  });

  it('restores project summary workspaces at their previous relative position', () => {
    const previousCache = {
      workspaces: [
        { id: 'ws-1', name: 'First' },
        { id: 'ws-2', name: 'Second' },
        { id: 'ws-3', name: 'Third' },
      ],
      reviewCount: 4,
    };
    const currentCache = {
      workspaces: [
        { id: 'ws-new', name: 'New snapshot item' },
        { id: 'ws-2', name: 'Second' },
        { id: 'ws-3', name: 'Third' },
      ],
      reviewCount: 2,
    };

    const updated = restoreWorkspacesToProjectSummaryCache(currentCache, previousCache, ['ws-1']);

    expect(updated).toEqual({
      workspaces: [
        { id: 'ws-new', name: 'New snapshot item' },
        { id: 'ws-1', name: 'First' },
        { id: 'ws-2', name: 'Second' },
        { id: 'ws-3', name: 'Third' },
      ],
      reviewCount: 2,
    });
  });

  it('does not duplicate workspaces already restored by another cache update', () => {
    const previousCache = {
      workspaces: [{ id: 'ws-1', name: 'Old snapshot' }],
      reviewCount: 4,
    };
    const currentCache = {
      workspaces: [{ id: 'ws-1', name: 'Fresh snapshot' }],
      reviewCount: 3,
    };

    const updated = restoreWorkspacesToProjectSummaryCache(currentCache, previousCache, ['ws-1']);

    expect(updated).toBe(currentCache);
  });

  it('restores only missing workspaces to list caches', () => {
    const previousCache = [
      { id: 'ws-1', name: 'Archived workspace' },
      { id: 'ws-2', name: 'Still current' },
    ];
    const currentCache = [{ id: 'ws-2', name: 'Still current' }];

    const updated = restoreWorkspacesToListCache(currentCache, previousCache, ['ws-1']);

    expect(updated).toEqual([
      { id: 'ws-1', name: 'Archived workspace' },
      { id: 'ws-2', name: 'Still current' },
    ]);
  });

  it('restores the previous list cache when the current cache is missing', () => {
    const previousCache = [
      { id: 'ws-1', name: 'Archived workspace' },
      { id: 'ws-2', name: 'Still current' },
    ];

    const updated = restoreWorkspacesToListCache(undefined, previousCache, ['ws-1']);

    expect(updated).toBe(previousCache);
  });

  it('restores list cache workspaces at their previous relative position', () => {
    const previousCache = [
      { id: 'ws-1', name: 'First' },
      { id: 'ws-2', name: 'Second' },
      { id: 'ws-3', name: 'Third' },
    ];
    const currentCache = [
      { id: 'ws-new', name: 'New snapshot item' },
      { id: 'ws-2', name: 'Second' },
      { id: 'ws-3', name: 'Third' },
    ];

    const updated = restoreWorkspacesToListCache(currentCache, previousCache, ['ws-1']);

    expect(updated).toEqual([
      { id: 'ws-new', name: 'New snapshot item' },
      { id: 'ws-1', name: 'First' },
      { id: 'ws-2', name: 'Second' },
      { id: 'ws-3', name: 'Third' },
    ]);
  });
});
