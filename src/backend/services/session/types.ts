import type { SessionProvider, SessionStatus, WorkspaceStatus } from '@/shared/core';

export interface SessionWorkspaceRecord {
  status: WorkspaceStatus;
  worktreePath: string | null;
  initErrorMessage: string | null;
}

/** Persistence-independent session record exposed by the session capsule. */
export interface AgentSessionRecord {
  id: string;
  workspaceId: string;
  name: string | null;
  workflow: string;
  model: string;
  status: SessionStatus;
  provider: SessionProvider;
  providerSessionId: string | null;
  providerProjectPath: string | null;
  providerProcessPid: number | null;
  providerMetadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentSessionRecordWithWorkspace extends AgentSessionRecord {
  workspace: SessionWorkspaceRecord;
}
