import { describe, expect, it } from 'vitest';
import { createOptimisticWorkspaceSummary } from '@/client/lib/workspace-summary';
import { filterBoardWorkspaces, sortBoardWorkspaces } from './board-view';

const workspace = (id: string, waitingSince: string | null, createdAt: string) => ({
  ...createOptimisticWorkspaceSummary({ id, name: id, projectId: 'p', ratchetEnabled: false }),
  kanbanColumn: 'WAITING' as const,
  waitingSince,
  createdAt: new Date(createdAt),
});
describe('board view', () => {
  it('sorts oldest known Waiting first without substituting creation time', () => {
    const rows = [
      workspace('unknown', null, '2020-01-01'),
      workspace('new', '2026-11-02T00:00:00Z', '2020-01-02'),
      workspace('old', '2026-11-01T00:00:00Z', '2020-01-03'),
    ];
    expect(sortBoardWorkspaces(rows).map((row) => row.id)).toEqual(['old', 'new', 'unknown']);
    expect(rows[0]?.id).toBe('unknown');
  });
  it('filters names, branches and summary text case insensitively', () => {
    const row = {
      ...workspace('Login', null, '2020-01-01'),
      branchName: 'fix/auth',
      conversationSummary: {
        title: 'Login',
        branch: 'fix-auth',
        summary: 'Rotate credentials',
        sidebarSummary: 'Rotate credentials',
        generatedAt: '2026-11-04T12:00:00Z',
        sourceSessionId: 's',
        sourceMessageId: 'm',
      },
    };
    expect(filterBoardWorkspaces([row], 'LOGIN')).toEqual([row]);
    expect(filterBoardWorkspaces([row], 'CREDENTIALS')).toEqual([row]);
    expect(filterBoardWorkspaces([row], 'AUTH')).toEqual([row]);
    expect(filterBoardWorkspaces([row], 'missing')).toEqual([]);
  });
});
