import type { AcpClientOptions } from '@/backend/services/session/service/acp';

export type SessionStartupLease = Readonly<{
  sessionId: string;
  generation: number;
}>;

export interface SessionAcpEnvironmentPort {
  getBackendPort(): number;
  getMcpServers(context: {
    workspaceId: string;
    parentWorkspaceId: string | null;
  }): AcpClientOptions['mcpServers'];
}
