import type { SessionStatus } from '@factory-factory/core';
import type { SessionProvider, TerminalSession } from '@prisma-gen/client';
import {
  type ClaudeSession,
  claudeSessionAccessor,
} from '@/backend/resource_accessors/claude-session.accessor';
import { terminalSessionAccessor } from '@/backend/resource_accessors/terminal-session.accessor';

class SessionDataService {
  // Claude sessions

  findClaudeSessionById(id: string) {
    return claudeSessionAccessor.findById(id);
  }

  findClaudeSessionsByWorkspaceId(
    workspaceId: string,
    filters?: { status?: SessionStatus; provider?: SessionProvider; limit?: number }
  ): Promise<ClaudeSession[]> {
    return claudeSessionAccessor.findByWorkspaceId(workspaceId, filters);
  }

  createClaudeSession(data: {
    workspaceId: string;
    name?: string;
    workflow: string;
    model?: string;
    provider?: SessionProvider;
    claudeProjectPath?: string | null;
  }): Promise<ClaudeSession> {
    return claudeSessionAccessor.create(data);
  }

  updateClaudeSession(
    id: string,
    data: {
      name?: string;
      workflow?: string;
      model?: string;
      status?: SessionStatus;
      provider?: SessionProvider;
      claudeSessionId?: string | null;
      claudeProjectPath?: string | null;
      claudeProcessPid?: number | null;
    }
  ): Promise<ClaudeSession> {
    return claudeSessionAccessor.update(id, data);
  }

  deleteClaudeSession(id: string): Promise<ClaudeSession> {
    return claudeSessionAccessor.delete(id);
  }

  findClaudeSessionsWithPid(): Promise<ClaudeSession[]> {
    return claudeSessionAccessor.findWithPid();
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
