import type { ClaudeSession, Project, Workspace } from '@prisma-gen/client';
import {
  claudeSessionAccessor,
  projectAccessor,
  workspaceAccessor,
} from '../resource_accessors/index';

type SessionAccessor = {
  findById(id: string): Promise<ClaudeSession | null>;
  findByWorkspaceId(workspaceId: string): Promise<ClaudeSession[]>;
  update(
    id: string,
    data: Partial<Pick<ClaudeSession, 'status' | 'claudeProcessPid' | 'claudeSessionId'>>
  ): Promise<ClaudeSession>;
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
    data: Partial<Pick<ClaudeSession, 'status' | 'claudeProcessPid' | 'claudeSessionId'>>
  ): Promise<ClaudeSession> {
    return this.sessions.update(sessionId, data);
  }
}

export const sessionRepository = new SessionRepository();
