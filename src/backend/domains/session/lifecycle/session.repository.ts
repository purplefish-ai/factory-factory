import type { Project, Workspace } from '@prisma-gen/client';
import type { AgentSessionRecord } from '@/backend/resource_accessors/agent-session.accessor';
import { agentSessionAccessor } from '@/backend/resource_accessors/agent-session.accessor';
import { projectAccessor } from '@/backend/resource_accessors/project.accessor';
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';

type SessionAccessor = {
  findById(id: string): Promise<AgentSessionRecord | null>;
  findByWorkspaceId(workspaceId: string): Promise<AgentSessionRecord[]>;
  update(
    id: string,
    data: Partial<
      Pick<
        AgentSessionRecord,
        'status' | 'providerProcessPid' | 'providerSessionId' | 'providerProjectPath'
      >
    >
  ): Promise<AgentSessionRecord>;
  delete(id: string): Promise<AgentSessionRecord>;
};

type WorkspaceAccessor = {
  findById(id: string): Promise<Workspace | null>;
  markHasHadSessions(id: string): Promise<void>;
  clearRatchetActiveSession(workspaceId: string, sessionId: string): Promise<void>;
};

type ProjectAccessor = {
  findById(id: string): Promise<Project | null>;
};

export class SessionRepository {
  constructor(
    private readonly sessions: SessionAccessor = agentSessionAccessor,
    private readonly workspaces: WorkspaceAccessor = workspaceAccessor,
    private readonly projects: ProjectAccessor = projectAccessor
  ) {}

  getSessionById(sessionId: string): Promise<AgentSessionRecord | null> {
    return this.sessions.findById(sessionId);
  }

  getSessionsByWorkspaceId(workspaceId: string): Promise<AgentSessionRecord[]> {
    return this.sessions.findByWorkspaceId(workspaceId);
  }

  getWorkspaceById(workspaceId: string): Promise<Workspace | null> {
    return this.workspaces.findById(workspaceId);
  }

  getProjectById(projectId: string): Promise<Project | null> {
    return this.projects.findById(projectId);
  }

  markWorkspaceHasHadSessions(workspaceId: string): Promise<void> {
    return this.workspaces.markHasHadSessions(workspaceId);
  }

  clearRatchetActiveSession(workspaceId: string, sessionId: string): Promise<void> {
    return this.workspaces.clearRatchetActiveSession(workspaceId, sessionId);
  }

  updateSession(
    sessionId: string,
    data: Partial<
      Pick<
        AgentSessionRecord,
        'status' | 'providerProcessPid' | 'providerSessionId' | 'providerProjectPath'
      >
    >
  ): Promise<AgentSessionRecord> {
    return this.updateSessionWithGuards(sessionId, data);
  }

  private async updateSessionWithGuards(
    sessionId: string,
    data: Partial<
      Pick<
        AgentSessionRecord,
        'status' | 'providerProcessPid' | 'providerSessionId' | 'providerProjectPath'
      >
    >
  ): Promise<AgentSessionRecord> {
    if (Object.hasOwn(data, 'providerSessionId')) {
      const current = await this.sessions.findById(sessionId);
      if (!current) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const currentSessionId = current.providerSessionId;
      const nextSessionId = data.providerSessionId ?? null;
      if (currentSessionId && nextSessionId !== currentSessionId) {
        throw new Error(
          `providerSessionId is immutable for session ${sessionId}: ${currentSessionId} -> ${String(nextSessionId)}`
        );
      }
    }

    return this.sessions.update(sessionId, data);
  }

  deleteSession(sessionId: string): Promise<AgentSessionRecord> {
    return this.sessions.delete(sessionId);
  }
}

export const sessionRepository = new SessionRepository();
