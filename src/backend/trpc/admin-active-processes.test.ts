import { describe, expect, it } from 'vitest';
import { SessionStatus } from '@/shared/core';
import {
  type ActiveAcpProcess,
  type AgentSessionProcessRecord,
  buildAgentProcesses,
  mergeAgentSessions,
  type WorkspaceProcessRecord,
} from './admin-active-processes';

const now = new Date('2026-02-15T12:00:00.000Z');

function createSession(overrides: Partial<AgentSessionProcessRecord>): AgentSessionProcessRecord {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    name: 'Chat 1',
    workflow: 'user',
    model: 'gpt-5',
    status: SessionStatus.RUNNING,
    providerProcessPid: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createWorkspace(
  overrides: Partial<WorkspaceProcessRecord> & Pick<WorkspaceProcessRecord, 'id'>
): WorkspaceProcessRecord {
  const { id, ...rest } = overrides;
  return {
    id,
    name: 'Workspace',
    branchName: 'main',
    project: { slug: 'demo-project' },
    ...rest,
  };
}

function createMemProcess(
  overrides: Partial<ActiveAcpProcess> & Pick<ActiveAcpProcess, 'sessionId'>
): ActiveAcpProcess {
  const { sessionId, ...rest } = overrides;
  return {
    sessionId,
    pid: 1234,
    status: 'running',
    isRunning: true,
    ...rest,
  };
}

describe('mergeAgentSessions', () => {
  it('keeps active sessions and appends non-overlapping PID sessions', () => {
    const active = [createSession({ id: 'active-1' })];
    const withPid = [
      createSession({ id: 'active-1', providerProcessPid: 123 }),
      createSession({ id: 'pid-only-1', providerProcessPid: 456 }),
    ];

    const merged = mergeAgentSessions(active, withPid);
    expect(merged).toHaveLength(2);
    expect(merged.map((session) => session.id)).toEqual(['active-1', 'pid-only-1']);
    expect(merged[0]?.providerProcessPid).toBeNull();
  });
});

describe('buildAgentProcesses', () => {
  it('maps active ACP sessions by session id even when DB pid is null', () => {
    const session = createSession({
      id: 'session-without-db-pid',
      workspaceId: 'workspace-real',
      providerProcessPid: null,
    });
    const workspaceMap = new Map<string, WorkspaceProcessRecord>([
      [
        'workspace-real',
        createWorkspace({ id: 'workspace-real', name: 'Real Workspace', branchName: 'feature/a' }),
      ],
    ]);

    const result = buildAgentProcesses({
      activeAcpProcesses: [createMemProcess({ sessionId: 'session-without-db-pid', pid: 4321 })],
      dbSessions: [session],
      workspaceById: workspaceMap,
    });

    expect(result.orphanedSessionIds).toEqual([]);
    expect(result.agentProcesses).toHaveLength(1);
    expect(result.agentProcesses[0]?.workspaceName).toBe('Real Workspace');
    expect(result.agentProcesses[0]?.workspaceId).toBe('workspace-real');
    expect(result.agentProcesses[0]?.pid).toBe(4321);
    expect(result.agentProcesses[0]?.inMemory).toBe(true);
  });

  it('keeps true in-memory orphans and includes db-only pid sessions', () => {
    const workspaceMap = new Map<string, WorkspaceProcessRecord>([
      ['workspace-1', createWorkspace({ id: 'workspace-1', name: 'Workspace One' })],
      ['workspace-2', createWorkspace({ id: 'workspace-2', name: 'Workspace Two' })],
    ]);

    const result = buildAgentProcesses({
      activeAcpProcesses: [createMemProcess({ sessionId: 'missing-db-session', pid: 9999 })],
      dbSessions: [
        createSession({
          id: 'db-only-session',
          workspaceId: 'workspace-2',
          providerProcessPid: 2222,
        }),
      ],
      workspaceById: workspaceMap,
    });

    expect(result.orphanedSessionIds).toEqual(['missing-db-session']);
    expect(result.agentProcesses).toHaveLength(2);

    const orphan = result.agentProcesses.find(
      (process) => process.sessionId === 'missing-db-session'
    );
    const dbOnly = result.agentProcesses.find((process) => process.sessionId === 'db-only-session');

    expect(orphan?.workspaceName).toBe('Unknown (orphan)');
    expect(orphan?.workspaceId).toBe('unknown');
    expect(orphan?.inMemory).toBe(true);

    expect(dbOnly?.workspaceName).toBe('Workspace Two');
    expect(dbOnly?.inMemory).toBe(false);
    expect(dbOnly?.pid).toBe(2222);
  });
});
