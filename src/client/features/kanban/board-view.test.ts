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
  it('sorts Waiting by latest activity by default, falling back to creation', () => {
    const rows = [
      { ...workspace('newest-created', null, '2026-11-03'), lastActivityAt: null },
      {
        ...workspace('latest-message', null, '2026-11-01'),
        lastActivityAt: '2026-11-04T00:00:00Z',
      },
      { ...workspace('older-message', null, '2026-11-02'), lastActivityAt: '2026-11-02T12:00:00Z' },
    ];
    expect(sortBoardWorkspaces(rows).map((row) => row.id)).toEqual([
      'latest-message',
      'newest-created',
      'older-message',
    ]);
    expect(rows[0]?.id).toBe('newest-created');
    expect(sortBoardWorkspaces(rows, 'created').map((row) => row.id)).toEqual([
      'newest-created',
      'older-message',
      'latest-message',
    ]);
  });

  it('keeps other columns newest-created and breaks activity ties by creation', () => {
    const rows = [
      { ...workspace('old', null, '2026-11-01'), lastActivityAt: '2026-11-04T00:00:00Z' },
      { ...workspace('new', null, '2026-11-02'), lastActivityAt: '2026-11-04T00:00:00Z' },
    ];
    expect(sortBoardWorkspaces(rows).map((row) => row.id)).toEqual(['new', 'old']);
    expect(
      sortBoardWorkspaces(
        rows.map((row, index) => ({
          ...row,
          kanbanColumn: 'WORKING',
          lastActivityAt: index === 0 ? '2026-11-05T00:00:00Z' : row.lastActivityAt,
        }))
      ).map((row) => row.id)
    ).toEqual(['new', 'old']);
    expect(
      sortBoardWorkspaces(rows.map((row) => ({ ...row, lastActivityAt: 'invalid' }))).map(
        (row) => row.id
      )
    ).toEqual(['new', 'old']);
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
