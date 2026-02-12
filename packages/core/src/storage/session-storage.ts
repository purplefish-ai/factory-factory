import type { SessionStatus } from '../types/enums.js';

export interface SessionRecord {
  id: string;
  workspaceId: string;
  name: string | null;
  workflow: string;
  model: string;
  status: SessionStatus;
  claudeSessionId: string | null;
  claudeProjectPath: string | null;
  claudeProcessPid: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionWithWorkspace extends SessionRecord {
  workspace: {
    id: string;
    projectId: string;
    name: string;
    worktreePath: string | null;
    branchName: string | null;
  };
}

export interface SessionStorage {
  create(data: CreateSessionInput): Promise<SessionRecord>;
  findById(id: string): Promise<SessionWithWorkspace | null>;
  findByWorkspaceId(
    workspaceId: string,
    filters?: { status?: SessionStatus; limit?: number }
  ): Promise<SessionRecord[]>;
  update(id: string, data: Partial<SessionRecord>): Promise<SessionRecord>;
  delete(id: string): Promise<SessionRecord>;
  findWithPid(): Promise<SessionRecord[]>;
  acquireFixerSession(input: AcquireFixerSessionInput): Promise<FixerSessionAcquisition>;
}

export interface CreateSessionInput {
  workspaceId: string;
  name?: string;
  workflow: string;
  model?: string;
  claudeProjectPath?: string | null;
}

export interface AcquireFixerSessionInput {
  workspaceId: string;
  workflow: string;
  sessionName: string;
  maxSessions: number;
  claudeProjectPath: string | null;
}

export type FixerSessionAcquisition =
  | { outcome: 'existing'; sessionId: string; status: SessionStatus }
  | { outcome: 'limit_reached' }
  | { outcome: 'created'; sessionId: string };
