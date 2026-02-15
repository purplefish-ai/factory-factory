import type { SessionProvider, TerminalSession } from '@prisma-gen/client';
import {
  type AgentSessionRecord,
  agentSessionAccessor,
} from '@/backend/resource_accessors/agent-session.accessor';
import { terminalSessionAccessor } from '@/backend/resource_accessors/terminal-session.accessor';
import type { SessionStatus } from '@/shared/core';

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

  createAgentSession(data: {
    workspaceId: string;
    name?: string;
    workflow: string;
    model?: string;
    provider?: SessionProvider;
    providerProjectPath?: string | null;
  }): Promise<AgentSessionRecord> {
    return agentSessionAccessor.create(data);
  }

  updateAgentSession(
    id: string,
    data: {
      name?: string;
      workflow?: string;
      model?: string;
      status?: SessionStatus;
      provider?: SessionProvider;
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

  // Terminal sessions

  findTerminalSessionById(id: string) {
    return terminalSessionAccessor.findById(id);
  }

  findTerminalSessionsByWorkspaceId(
    workspaceId: string,
    filters?: { status?: SessionStatus; limit?: number }
  ): Promise<TerminalSession[]> {
    return terminalSessionAccessor.findByWorkspaceId(workspaceId, filters);
  }

  createTerminalSession(data: {
    workspaceId: string;
    name?: string;
    pid?: number;
  }): Promise<TerminalSession> {
    return terminalSessionAccessor.create(data);
  }

  updateTerminalSession(id: string, data: { name?: string }): Promise<TerminalSession> {
    return terminalSessionAccessor.update(id, data);
  }

  deleteTerminalSession(id: string): Promise<TerminalSession> {
    return terminalSessionAccessor.delete(id);
  }

  findTerminalSessionsWithPid(): Promise<TerminalSession[]> {
    return terminalSessionAccessor.findWithPid();
  }

  clearTerminalPid(name: string): Promise<void> {
    return terminalSessionAccessor.clearPid(name);
  }
}

export const sessionDataService = new SessionDataService();
