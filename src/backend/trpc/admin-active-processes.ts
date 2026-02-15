import { SessionStatus } from '@/shared/core';

export interface ActiveAcpProcess {
  sessionId: string;
  pid: number | undefined;
  status: string;
  isRunning: boolean;
}

export interface AgentSessionProcessRecord {
  id: string;
  workspaceId: string;
  name: string | null;
  workflow: string;
  model: string;
  status: SessionStatus;
  providerProcessPid: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceProcessRecord {
  id: string;
  name: string;
  branchName: string | null;
  project: {
    slug: string;
  };
}

export interface AgentProcessRow {
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  workspaceBranch: string | null;
  projectSlug: string | null;
  name: string | null;
  workflow: string;
  model: string;
  pid: number | null;
  status: SessionStatus;
  inMemory: boolean;
  memoryStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
  cpuPercent: number | null;
  memoryBytes: number | null;
  idleTimeMs: number | null;
}

function toWorkspaceFields(
  workspace: WorkspaceProcessRecord | undefined
): Pick<AgentProcessRow, 'workspaceName' | 'workspaceBranch' | 'projectSlug'> {
  return {
    workspaceName: workspace?.name ?? 'Unknown',
    workspaceBranch: workspace?.branchName ?? null,
    projectSlug: workspace?.project.slug ?? null,
  };
}

function createOrphanInMemoryRow(memProcess: ActiveAcpProcess): AgentProcessRow {
  return {
    sessionId: memProcess.sessionId,
    workspaceId: 'unknown',
    workspaceName: 'Unknown (orphan)',
    workspaceBranch: null,
    projectSlug: null,
    name: null,
    workflow: 'unknown',
    model: 'unknown',
    pid: memProcess.pid ?? null,
    status: memProcess.isRunning ? SessionStatus.RUNNING : SessionStatus.COMPLETED,
    inMemory: true,
    memoryStatus: memProcess.status,
    createdAt: new Date(),
    updatedAt: new Date(),
    cpuPercent: null,
    memoryBytes: null,
    idleTimeMs: null,
  };
}

function createInMemoryRow(
  session: AgentSessionProcessRecord,
  memProcess: ActiveAcpProcess,
  workspace: WorkspaceProcessRecord | undefined
): AgentProcessRow {
  return {
    sessionId: session.id,
    workspaceId: session.workspaceId,
    ...toWorkspaceFields(workspace),
    name: session.name,
    workflow: session.workflow,
    model: session.model,
    pid: session.providerProcessPid ?? memProcess.pid ?? null,
    status: session.status,
    inMemory: true,
    memoryStatus: memProcess.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    cpuPercent: null,
    memoryBytes: null,
    idleTimeMs: null,
  };
}

function createDbOnlyRow(
  session: AgentSessionProcessRecord,
  workspace: WorkspaceProcessRecord | undefined
): AgentProcessRow {
  return {
    sessionId: session.id,
    workspaceId: session.workspaceId,
    ...toWorkspaceFields(workspace),
    name: session.name,
    workflow: session.workflow,
    model: session.model,
    pid: session.providerProcessPid,
    status: session.status,
    inMemory: false,
    memoryStatus: null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    cpuPercent: null,
    memoryBytes: null,
    idleTimeMs: null,
  };
}

export function mergeAgentSessions(
  activeSessionsById: AgentSessionProcessRecord[],
  sessionsWithPid: AgentSessionProcessRecord[]
): AgentSessionProcessRecord[] {
  const merged = new Map<string, AgentSessionProcessRecord>();
  for (const session of activeSessionsById) {
    merged.set(session.id, session);
  }
  for (const session of sessionsWithPid) {
    if (!merged.has(session.id)) {
      merged.set(session.id, session);
    }
  }
  return Array.from(merged.values());
}

export function buildAgentProcesses(params: {
  activeAcpProcesses: ActiveAcpProcess[];
  dbSessions: AgentSessionProcessRecord[];
  workspaceById: ReadonlyMap<string, WorkspaceProcessRecord>;
}): { agentProcesses: AgentProcessRow[]; orphanedSessionIds: string[] } {
  const { activeAcpProcesses, dbSessions, workspaceById } = params;
  const dbSessionsById = new Map(dbSessions.map((session) => [session.id, session]));
  const activeSessionIds = new Set(activeAcpProcesses.map((process) => process.sessionId));
  const agentProcesses: AgentProcessRow[] = [];
  const orphanedSessionIds: string[] = [];

  for (const memProcess of activeAcpProcesses) {
    const session = dbSessionsById.get(memProcess.sessionId);
    if (!session) {
      orphanedSessionIds.push(memProcess.sessionId);
      agentProcesses.push(createOrphanInMemoryRow(memProcess));
      continue;
    }

    agentProcesses.push(
      createInMemoryRow(session, memProcess, workspaceById.get(session.workspaceId))
    );
  }

  for (const session of dbSessions) {
    if (activeSessionIds.has(session.id)) {
      continue;
    }
    agentProcesses.push(createDbOnlyRow(session, workspaceById.get(session.workspaceId)));
  }

  return { agentProcesses, orphanedSessionIds };
}
