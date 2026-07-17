import type { TerminalSession } from '@prisma-gen/client';
import { isProcessRunning } from '@/backend/lib/process-liveness';
import { terminalSessionAccessor } from '@/backend/services/terminal/resources/terminal-session.accessor';
import { SessionStatus } from '@/shared/core';

export type { TerminalSession } from '@prisma-gen/client';

class TerminalSessionService {
  findById(id: string) {
    return terminalSessionAccessor.findById(id);
  }

  findByWorkspaceId(
    workspaceId: string,
    filters?: { status?: SessionStatus; limit?: number }
  ): Promise<TerminalSession[]> {
    return terminalSessionAccessor.findByWorkspaceId(workspaceId, filters);
  }

  create(data: { workspaceId: string; name?: string; pid?: number }): Promise<TerminalSession> {
    return terminalSessionAccessor.create(data);
  }

  update(
    id: string,
    data: { name?: string; status?: SessionStatus; pid?: number | null }
  ): Promise<TerminalSession> {
    return terminalSessionAccessor.update(id, data);
  }

  delete(id: string): Promise<TerminalSession> {
    return terminalSessionAccessor.delete(id);
  }

  findWithPid(): Promise<TerminalSession[]> {
    return terminalSessionAccessor.findWithPid();
  }

  clearPid(workspaceId: string, name: string): Promise<void> {
    return terminalSessionAccessor.clearPid(workspaceId, name);
  }

  async recoverOrphanedSessions(): Promise<number> {
    const sessions = await terminalSessionAccessor.findWithPid();
    let recovered = 0;

    for (const session of sessions) {
      if (!session.pid || isProcessRunning(session.pid)) {
        continue;
      }

      await terminalSessionAccessor.update(session.id, {
        status: SessionStatus.IDLE,
        pid: null,
      });
      recovered += 1;
    }

    return recovered;
  }
}

export const terminalSessionService = new TerminalSessionService();
