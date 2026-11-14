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
        { sessionId: 's1', pid: 200 },
        { sessionId: 's2', pid: undefined },
      ],
      findSessions: () =>
        Promise.resolve([
          { id: 's1', workspaceId: 'w1', providerProcessPid: 201 },
          { id: 's2', workspaceId: 'w2', providerProcessPid: null },
        ]),
      listTerminals: () => [{ pid: 300, workspaceId: 'w1' }],
      findWorkspaces: () =>
        Promise.resolve([{ id: 'w1', name: 'Fix login', project: { slug: 'repo' } }]),
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
    expect(owners?.size).toBe(4);
  });
});
