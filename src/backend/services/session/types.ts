import type { SessionProvider, SessionStatus, WorkspaceStatus } from '@/shared/core';
import type { PRTarget } from '@/shared/pr-monitoring';

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
  workspacePrId?: string | null;
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

export interface AcquirePRDedicatedSessionInput extends PRTarget {
  provider?: SessionProvider;
  model?: string;
  maxSessions: number;
  expectedBindingRevision?: number;
  isCurrent?: () => boolean;
}
export type PRDedicatedSessionAcquisition =
  | { outcome: 'created' | 'reused'; session: AgentSessionRecord }
  | { outcome: 'limit_reached' | 'unavailable' };
