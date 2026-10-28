import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { workspaceDetailQueryOptions } from '@/client/lib/workspace-cache-reconciler';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  type CreatedWorkspace,
  seedCreatedWorkspaceDetail,
  removeWorkspaceFromProjectWorkspaceCache,
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
    expect(
      client.getQueryCache().find({ queryKey: options.queryKey })?.options.structuralSharing
    ).toBe(options.structuralSharing);
    seedCreatedWorkspaceDetail(client, { ...workspace, name: 'Duplicate response' });
    expect(client.getQueryData(options.queryKey)).toBe(cached);
    client.removeQueries({ queryKey: options.queryKey, exact: true });
    expect(client.getQueryDefaults(options.queryKey).structuralSharing).toBeUndefined();
    const reopened = workspaceDetailQueryOptions(client, workspace.id, () =>
      Promise.resolve(cached)
    );
    await client.fetchQuery(reopened);
    expect(client.getQueryData(reopened.queryKey)).toMatchObject({ name: 'Created' });
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
});
