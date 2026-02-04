import { describe, expect, it } from 'vitest';
import type { ServerWorkspace } from './use-workspace-list-state';
import { sortWorkspaces } from './use-workspace-list-state';

function makeWorkspace(
  overrides: Partial<ServerWorkspace> & { id: string; name: string; createdAt: string | Date }
): ServerWorkspace {
  const { id, name, createdAt, ...rest } = overrides;
  return {
    id,
    name,
    createdAt,
    isWorking: false,
    gitStats: null,
    branchName: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prCiStatus: null,
    ...rest,
  };
}

describe('sortWorkspaces', () => {
  it('sorts by createdAt desc when no custom order is provided', () => {
    const workspaces = [
      makeWorkspace({ id: 'a', name: 'Alpha', createdAt: '2024-01-01T00:00:00Z' }),
      makeWorkspace({ id: 'b', name: 'Beta', createdAt: '2024-02-01T00:00:00Z' }),
      makeWorkspace({ id: 'c', name: 'Charlie', createdAt: '2024-01-15T00:00:00Z' }),
    ];

    const sorted = sortWorkspaces(workspaces, undefined);

    expect(sorted.map((w) => w.id)).toEqual(['b', 'c', 'a']);
  });

  it('places workspaces missing from custom order at the top (newest first)', () => {
    const workspaces = [
      makeWorkspace({ id: 'a', name: 'Alpha', createdAt: '2024-01-01T00:00:00Z' }),
      makeWorkspace({ id: 'b', name: 'Beta', createdAt: '2024-01-02T00:00:00Z' }),
      makeWorkspace({ id: 'c', name: 'Gamma', createdAt: '2024-03-01T00:00:00Z' }),
      makeWorkspace({ id: 'd', name: 'Delta', createdAt: '2024-02-15T00:00:00Z' }),
    ];

    const sorted = sortWorkspaces(workspaces, ['b', 'a']);

    expect(sorted.map((w) => w.id)).toEqual(['c', 'd', 'b', 'a']);
  });

  it('keeps custom order stable regardless of createdAt', () => {
    const workspaces = [
      makeWorkspace({ id: 'a', name: 'Alpha', createdAt: '2024-03-01T00:00:00Z' }),
      makeWorkspace({ id: 'b', name: 'Beta', createdAt: '2024-01-01T00:00:00Z' }),
      makeWorkspace({ id: 'c', name: 'Gamma', createdAt: '2024-02-01T00:00:00Z' }),
    ];

    const sorted = sortWorkspaces(workspaces, ['b', 'a', 'c']);

    expect(sorted.map((w) => w.id)).toEqual(['b', 'a', 'c']);
  });
});
