import { describe, expect, it, vi } from 'vitest';
import { workspaceQueryService } from './workspace-query.service';

const { findWorkspaces } = vi.hoisted(() => ({ findWorkspaces: vi.fn() }));

vi.mock('@/backend/services/workspace/resources/workspace.accessor', () => ({
  workspaceAccessor: { findByProjectIdWithSessions: findWorkspaces },
}));
vi.mock('@/backend/services/workspace/resources/project.accessor', () => ({
  projectAccessor: { findById: vi.fn().mockResolvedValue({ defaultBranch: 'main' }) },
}));

describe('workspace collection last activity', () => {
  it.each([
    {
      agentDates: ['invalid'],
      terminalDates: ['2026-01-03T14:00:00Z'],
      expected: '2026-01-03T14:00:00.000Z',
    },
    {
      agentDates: ['2026-01-03T14:00:00Z'],
      terminalDates: ['invalid'],
      expected: '2026-01-03T14:00:00.000Z',
    },
    { agentDates: ['invalid'], terminalDates: ['invalid'], expected: null },
    { agentDates: [], terminalDates: [], expected: null },
  ])(
    'returns $expected for agent dates $agentDates and terminal dates $terminalDates',
    async ({ agentDates, terminalDates, expected }) => {
      findWorkspaces.mockResolvedValue([
        {
          id: 'ws-1',
          projectId: 'proj-1',
          name: 'Test workspace',
          status: 'READY',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          worktreePath: null,
          prState: 'NONE',
          prs: [],
          ratchetEnabled: false,
          ratchetState: 'IDLE',
          hasHadSessions: true,
          agentSessions: agentDates.map((date, index) => ({
            id: `agent-${index}`,
            name: null,
            workflow: null,
            model: null,
            status: 'IDLE',
            updatedAt: new Date(date),
          })),
          terminalSessions: terminalDates.map((date, index) => ({
            id: `terminal-${index}`,
            updatedAt: new Date(date),
          })),
        },
      ]);
      workspaceQueryService.configure({
        session: {
          getAllPendingRequests: () => new Map(),
          getRuntimeSnapshot: () => ({
            phase: 'idle',
            processState: 'alive',
            activity: 'IDLE',
            updatedAt: '2026-01-03T14:00:00.000Z',
          }),
        },
        github: {
          checkHealth: vi.fn().mockResolvedValue({ isInstalled: false, isAuthenticated: false }),
          listReviewRequests: vi.fn().mockResolvedValue([]),
        },
        prSnapshot: { refreshWorkspace: vi.fn().mockResolvedValue(undefined) },
      });

      const result = await workspaceQueryService.listForProject('proj-1');

      expect(result.workspaces).toHaveLength(1);
      expect(result.workspaces[0]?.lastActivityAt).toBe(expected);
    }
  );
});
