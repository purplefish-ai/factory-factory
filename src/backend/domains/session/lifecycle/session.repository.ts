import type { Project, Workspace } from '@prisma-gen/client';
import type { ClaudeSession } from '@/backend/resource_accessors/claude-session.accessor';
import {
  claudeSessionAccessor,
  projectAccessor,
  workspaceAccessor,
} from '@/backend/resource_accessors/index';

type SessionAccessor = {
  findById(id: string): Promise<ClaudeSession | null>;
  findByWorkspaceId(workspaceId: string): Promise<ClaudeSession[]>;
  update(
    id: string,
    data: Partial<
      Pick<ClaudeSession, 'status' | 'claudeProcessPid' | 'claudeSessionId' | 'claudeProjectPath'>
    >
  ): Promise<ClaudeSession>;
  delete(id: string): Promise<ClaudeSession>;
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
    private readonly sessions: SessionAccessor = claudeSessionAccessor,
    private readonly workspaces: WorkspaceAccessor = workspaceAccessor,
    private readonly projects: ProjectAccessor = projectAccessor
  ) {}

  getSessionById(sessionId: string): Promise<ClaudeSession | null> {
    return this.sessions.findById(sessionId);
  }

  getSessionsByWorkspaceId(workspaceId: string): Promise<ClaudeSession[]> {
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
      Pick<ClaudeSession, 'status' | 'claudeProcessPid' | 'claudeSessionId' | 'claudeProjectPath'>
    >
  ): Promise<ClaudeSession> {
    return this.updateSessionWithGuards(sessionId, data);
  }

  private async updateSessionWithGuards(
    sessionId: string,
    data: Partial<
      Pick<ClaudeSession, 'status' | 'claudeProcessPid' | 'claudeSessionId' | 'claudeProjectPath'>
    >
  ): Promise<ClaudeSession> {
    if (Object.hasOwn(data, 'claudeSessionId')) {
      const current = await this.sessions.findById(sessionId);
      if (!current) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const currentSessionId = current.claudeSessionId;
      const nextSessionId = data.claudeSessionId ?? null;
      if (currentSessionId && nextSessionId !== currentSessionId) {
        throw new Error(
          `claudeSessionId is immutable for session ${sessionId}: ${currentSessionId} -> ${String(nextSessionId)}`
        );
      }
    }

    return this.sessions.update(sessionId, data);
  }

  deleteSession(sessionId: string): Promise<ClaudeSession> {
    return this.sessions.delete(sessionId);
  }
}

export const sessionRepository = new SessionRepository();
