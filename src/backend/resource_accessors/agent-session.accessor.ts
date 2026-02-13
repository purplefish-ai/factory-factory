import type { SessionStatus } from '@factory-factory/core';
import type { Prisma, SessionProvider } from '@prisma-gen/client';
import {
  type ClaudeSession,
  type ClaudeSessionWithWorkspace,
  claudeSessionAccessor,
} from './claude-session.accessor';

export type AgentSessionRecord = ClaudeSession;
export type AgentSessionRecordWithWorkspace = ClaudeSessionWithWorkspace;

export interface AgentSessionFilters {
  status?: SessionStatus;
  provider?: SessionProvider;
  limit?: number;
}

export interface CreateAgentSessionInput {
  workspaceId: string;
  name?: string;
  workflow: string;
  model?: string;
  provider?: SessionProvider;
  claudeProjectPath?: string | null;
}

export interface UpdateAgentSessionInput {
  name?: string;
  workflow?: string;
  model?: string;
  status?: SessionStatus;
  provider?: SessionProvider;
  providerMetadata?: Prisma.InputJsonValue | null;
  claudeSessionId?: string | null;
  claudeProjectPath?: string | null;
  claudeProcessPid?: number | null;
}

export interface AcquireFixerAgentSessionInput {
  workspaceId: string;
  workflow: string;
  sessionName: string;
  maxSessions: number;
  provider?: SessionProvider;
  claudeProjectPath: string | null;
}

export type FixerAgentSessionAcquisition =
  | { outcome: 'existing'; sessionId: string; status: SessionStatus }
  | { outcome: 'limit_reached' }
  | { outcome: 'created'; sessionId: string };

export interface AgentSessionAccessor {
  create(data: CreateAgentSessionInput): Promise<AgentSessionRecord>;
  findById(id: string): Promise<AgentSessionRecordWithWorkspace | null>;
  findByWorkspaceId(
    workspaceId: string,
    filters?: AgentSessionFilters
  ): Promise<AgentSessionRecord[]>;
  update(id: string, data: UpdateAgentSessionInput): Promise<AgentSessionRecord>;
  delete(id: string): Promise<AgentSessionRecord>;
  findWithPid(): Promise<AgentSessionRecord[]>;
  acquireFixerSession(input: AcquireFixerAgentSessionInput): Promise<FixerAgentSessionAcquisition>;
}

export const agentSessionAccessor: AgentSessionAccessor = claudeSessionAccessor;
