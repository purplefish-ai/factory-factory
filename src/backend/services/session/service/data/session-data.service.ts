import type { Prisma, SessionProvider } from '@prisma-gen/client';
import {
  type AgentSessionRecord,
  agentSessionAccessor,
} from '@/backend/services/session/resources/agent-session.accessor';
import {
  type ClosedSessionRecord,
  type ClosedSessionWithWorkspace,
  closedSessionAccessor,
} from '@/backend/services/session/resources/closed-session.accessor';
import type { SessionStatus } from '@/shared/core';
import { sessionProviderResolverService } from './session-provider-resolver.service';

export type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';

class SessionDataService {
  // Agent sessions

  findAgentSessionById(id: string) {
    return agentSessionAccessor.findById(id);
  }

  findAgentSessionsByIds(ids: string[]): Promise<AgentSessionRecord[]> {
    return agentSessionAccessor.findByIds(ids);
  }

  findAgentSessionsByWorkspaceId(
    workspaceId: string,
    filters?: { status?: SessionStatus; provider?: SessionProvider; limit?: number }
  ): Promise<AgentSessionRecord[]> {
    return agentSessionAccessor.findByWorkspaceId(workspaceId, filters);
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
    return agentSessionAccessor.create({ ...data, ...defaults });
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
    return agentSessionAccessor.createWithinWorkspaceLimit({ ...data, ...defaults });
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
    return agentSessionAccessor.update(id, data);
  }

  deleteAgentSession(id: string): Promise<AgentSessionRecord> {
    return agentSessionAccessor.delete(id);
  }

  findAgentSessionsWithPid(): Promise<AgentSessionRecord[]> {
    return agentSessionAccessor.findWithPid();
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
