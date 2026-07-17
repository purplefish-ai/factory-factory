import type { Prisma, SessionProvider } from '@prisma-gen/client';
import {
  agentSessionAccessor,
  type AgentSessionRecord as PersistenceAgentSessionRecord,
  type AgentSessionRecordWithWorkspace as PersistenceAgentSessionRecordWithWorkspace,
} from '@/backend/services/session/resources/agent-session.accessor';
import {
  type ClosedSessionRecord,
  type ClosedSessionWithWorkspace,
  closedSessionAccessor,
} from '@/backend/services/session/resources/closed-session.accessor';
import type {
  AgentSessionRecord,
  AgentSessionRecordWithWorkspace,
} from '@/backend/services/session/types';
import type { SessionStatus } from '@/shared/core';
import { sessionProviderResolverService } from './session-provider-resolver.service';

function toAgentSessionRecord(session: PersistenceAgentSessionRecord): AgentSessionRecord {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    name: session.name,
    workflow: session.workflow,
    model: session.model,
    status: session.status,
    provider: session.provider,
    providerSessionId: session.providerSessionId,
    providerProjectPath: session.providerProjectPath,
    providerProcessPid: session.providerProcessPid,
    providerMetadata: session.providerMetadata,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function toAgentSessionRecordWithWorkspace(
  session: PersistenceAgentSessionRecordWithWorkspace
): AgentSessionRecordWithWorkspace {
  return {
    ...toAgentSessionRecord(session),
    workspace: {
      status: session.workspace.status,
      worktreePath: session.workspace.worktreePath,
      initErrorMessage: session.workspace.initErrorMessage,
    },
  };
}

class SessionDataService {
  // Agent sessions

  async findAgentSessionById(id: string): Promise<AgentSessionRecordWithWorkspace | null> {
    const session = await agentSessionAccessor.findById(id);
    return session ? toAgentSessionRecordWithWorkspace(session) : null;
  }

  async findAgentSessionsByIds(ids: string[]): Promise<AgentSessionRecord[]> {
    return (await agentSessionAccessor.findByIds(ids)).map(toAgentSessionRecord);
  }

  async findAgentSessionsByWorkspaceId(
    workspaceId: string,
    filters?: { status?: SessionStatus; provider?: SessionProvider; limit?: number }
  ): Promise<AgentSessionRecord[]> {
    return (await agentSessionAccessor.findByWorkspaceId(workspaceId, filters)).map(
      toAgentSessionRecord
    );
  }

  countActiveAgentSessionsByWorkspaceId(workspaceId: string): Promise<number> {
    return agentSessionAccessor.countActiveByWorkspaceId(workspaceId);
  }

  async createAgentSession(data: {
    workspaceId: string;
    name?: string;
    workflow: string;
    model?: string;
    provider?: SessionProvider;
    providerProjectPath?: string | null;
  }): Promise<AgentSessionRecord> {
    const defaults = await sessionProviderResolverService.resolveSessionDefaults({
      workspaceId: data.workspaceId,
      explicitProvider: data.provider,
      explicitModel: data.model,
    });
    return toAgentSessionRecord(await agentSessionAccessor.create({ ...data, ...defaults }));
  }

  async createAgentSessionWithinWorkspaceLimit(data: {
    workspaceId: string;
    name?: string;
    workflow: string;
    model?: string;
    provider?: SessionProvider;
    providerProjectPath?: string | null;
    maxSessions: number;
  }) {
    const defaults = await sessionProviderResolverService.resolveSessionDefaults({
      workspaceId: data.workspaceId,
      explicitProvider: data.provider,
      explicitModel: data.model,
    });
    const result = await agentSessionAccessor.createWithinWorkspaceLimit({ ...data, ...defaults });
    return result.outcome === 'created'
      ? { ...result, session: toAgentSessionRecord(result.session) }
      : result;
  }

  async acquireFixerSession(data: {
    workspaceId: string;
    workflow: string;
    sessionName: string;
    maxSessions: number;
    provider?: SessionProvider;
    providerProjectPath: string | null;
  }) {
    const defaults = await sessionProviderResolverService.resolveSessionDefaults({
      workspaceId: data.workspaceId,
      explicitProvider: data.provider,
    });
    return agentSessionAccessor.acquireFixerSession({ ...data, ...defaults });
  }

  updateAgentSession(
    id: string,
    data: {
      name?: string;
      workflow?: string;
      model?: string;
      status?: SessionStatus;
      provider?: SessionProvider;
      providerMetadata?: Prisma.InputJsonValue | null;
      providerSessionId?: string | null;
      providerProjectPath?: string | null;
      providerProcessPid?: number | null;
    }
  ): Promise<AgentSessionRecord> {
    return agentSessionAccessor.update(id, data).then(toAgentSessionRecord);
  }

  deleteAgentSession(id: string): Promise<AgentSessionRecord> {
    return agentSessionAccessor.delete(id).then(toAgentSessionRecord);
  }

  findAgentSessionsWithPid(): Promise<AgentSessionRecord[]> {
    return agentSessionAccessor
      .findWithPid()
      .then((sessions) => sessions.map(toAgentSessionRecord));
  }

  recoverStaleRunningAgentSessions(): Promise<number> {
    return agentSessionAccessor.recoverStaleRunning();
  }

  // Closed sessions

  findClosedSessionsByWorkspaceId(
    workspaceId: string,
    limit: number
  ): Promise<ClosedSessionRecord[]> {
    return closedSessionAccessor.findByWorkspaceId(workspaceId, limit);
  }

  findClosedSessionByIdWithWorkspace(id: string): Promise<ClosedSessionWithWorkspace | null> {
    return closedSessionAccessor.findByIdWithWorkspace(id);
  }

  deleteClosedSession(id: string): Promise<ClosedSessionRecord> {
    return closedSessionAccessor.delete(id);
  }
}

export const sessionDataService = new SessionDataService();
