import { describe, expect, it, vi } from 'vitest';
import type { ProcessOwner } from '@/backend/services/host-metrics';
import { getHostLoadBreakdown } from './host-load-breakdown.orchestrator';

describe('getHostLoadBreakdown', () => {
  it('names agent and terminal process trees after their workspace and ours after Factory Factory', async () => {
    const getTopProcesses = vi.fn((_owners: ReadonlyMap<number, ProcessOwner>) =>
      Promise.resolve({ byCpu: [], byMemory: [] })
    );

    await getHostLoadBreakdown({
      listAgentProcesses: () => [
        { sessionId: 's1', pid: 200, isRunning: true },
        { sessionId: 's2', pid: undefined, isRunning: true },
        { sessionId: 's3', pid: 400, isRunning: false },
      ],
      findSessions: (ids) =>
        Promise.resolve(
          [
            { id: 's1', workspaceId: 'w1', providerProcessPid: 201 },
            { id: 's2', workspaceId: 'w2', providerProcessPid: null },
            { id: 's3', workspaceId: 'w3', providerProcessPid: 401 },
          ].filter((session) => ids.includes(session.id))
        ),
      listTerminals: () => [{ pid: 300, workspaceId: 'w1' }],
      findWorkspaces: (ids) => {
        expect(ids).toEqual(['w1']);
        return Promise.resolve([{ id: 'w1', name: 'Fix login', project: { slug: 'repo' } }]);
      },
      serverPid: 100,
      getTopProcesses,
    });

    const owners = getTopProcesses.mock.calls[0]?.[0];
    expect(owners?.get(100)).toMatchObject({ label: 'Factory Factory', kind: 'factory' });
    for (const pid of [200, 201, 300]) {
      expect(owners?.get(pid)).toEqual({
        key: 'workspace:w1',
        label: 'Fix login',
        kind: 'workspace',
        workspace: { id: 'w1', projectSlug: 'repo' },
      });
    }
    // s3's adapter has stopped, so neither of its pids is attributed.
    expect(owners?.has(400)).toBe(false);
    expect(owners?.has(401)).toBe(false);
    expect(owners?.size).toBe(4);
  });
});
