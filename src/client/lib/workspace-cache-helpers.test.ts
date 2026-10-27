import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { workspaceDetailQueryOptions } from '@/client/lib/workspace-cache-reconciler';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  type CreatedWorkspace,
  seedCreatedWorkspaceDetail,
  removeWorkspaceFromProjectWorkspaceCache,
  removeWorkspacesFromProjectWorkspaceCache,
  restoreWorkspacesToProjectWorkspaceCache,
} from './workspace-cache-helpers';

describe('workspace-cache-helpers', () => {
  it('seeds creation data through shared cache options without replacing existing detail', async () => {
    const client = new QueryClient();
    const workspace = unsafeCoerce<CreatedWorkspace>({
      id: 'ws-1',
      projectId: 'proj-1',
      name: 'Created',
      status: 'NEW',
      mode: 'STANDARD',
      createdAt: new Date('2026-01-01'),
      ratchetEnabled: false,
    });
    seedCreatedWorkspaceDetail(client, workspace);
    const options = workspaceDetailQueryOptions(client, workspace.id, () =>
      Promise.reject(new Error('Unneeded fetch'))
    );
    const cached = await client.fetchQuery(options);
    expect(cached).toMatchObject({
      id: 'ws-1',
      name: 'Created',
      agentSessions: [],
      terminalSessions: [],
    });
    expect(
      client.getQueryCache().find({ queryKey: options.queryKey })?.options.initialData
    ).toBeUndefined();
    expect(client.getQueryDefaults(options.queryKey).structuralSharing).toBe(
      options.structuralSharing
    );
    seedCreatedWorkspaceDetail(client, { ...workspace, name: 'Duplicate response' });
    expect(client.getQueryData(options.queryKey)).toBe(cached);
    client.clear();
  });

  it('removes one workspace from project workspace cache', () => {
    const cache = {
      workspaces: [{ id: 'ws-1' }, { id: 'ws-2' }],
      reviewCount: 4,
    };

    const updated = removeWorkspaceFromProjectWorkspaceCache(cache, 'ws-1');

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

    const updated = removeWorkspaceFromProjectWorkspaceCache(cache, 'ws-404');

    expect(updated).toBe(cache);
  });

  it('removes multiple workspaces from project workspace cache', () => {
    const cache = {
      workspaces: [{ id: 'ws-1' }, { id: 'ws-2' }, { id: 'ws-3' }],
      reviewCount: 1,
    };

    const updated = removeWorkspacesFromProjectWorkspaceCache(cache, ['ws-1', 'ws-3']);

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

    const updated = restoreWorkspacesToProjectWorkspaceCache(currentCache, previousCache, ['ws-1']);

    expect(updated).toEqual({
      workspaces: [
        { id: 'ws-1', name: 'Archived workspace' },
        { id: 'ws-2', name: 'Still current' },
      ],
      reviewCount: 2,
    });
  });

  it('restores the previous project workspace cache when the current cache is missing', () => {
    const previousCache = {
      workspaces: [
        { id: 'ws-1', name: 'Archived workspace' },
        { id: 'ws-2', name: 'Still current' },
      ],
      reviewCount: 4,
    };

    const updated = restoreWorkspacesToProjectWorkspaceCache(undefined, previousCache, ['ws-1']);

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

    const updated = restoreWorkspacesToProjectWorkspaceCache(currentCache, previousCache, ['ws-1']);

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

    const updated = restoreWorkspacesToProjectWorkspaceCache(currentCache, previousCache, ['ws-1']);

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

    const updated = restoreWorkspacesToProjectWorkspaceCache(currentCache, previousCache, ['ws-1']);

    expect(updated).toBe(currentCache);
  });
});
