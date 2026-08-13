import { configService } from '@/backend/services/config.service';
import { serverInstanceService } from '@/backend/services/server-instance.service';
import { getChildWorkspaceMcpServerConfig } from '@/backend/services/session/service/acp/child-workspace-mcp-server';
import { userSettingsService } from '@/backend/services/settings';
import { sessionPromptBuilder } from './session.prompt-builder';
import { sessionRepository } from './session.repository';
import { SessionContextService } from './session-context.service';
import type { SessionAcpEnvironmentPort } from './session-lifecycle.types';

export const sessionContextService = new SessionContextService({
  repository: sessionRepository,
  promptBuilder: sessionPromptBuilder,
  permissionPresetPort: {
    async getPermissionPreset(workflow) {
      const settings = await userSettingsService.get();
      return workflow === 'ratchet'
        ? settings.ratchetPermissions
        : settings.defaultWorkspacePermissions;
    },
  },
});

const getBackendPort = (): number =>
  serverInstanceService.getPort() ?? configService.getBackendPort();

function getBackendBaseUrl(): string {
  const host = configService.getBackendHost() ?? 'localhost';
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${urlHost}:${getBackendPort()}`;
}

export const sessionAcpEnvironment: SessionAcpEnvironmentPort = {
  getBackendPort,
  getMcpServers: ({ workspaceId, parentWorkspaceId }) => [
    getChildWorkspaceMcpServerConfig({
      workspaceId,
      parentWorkspaceId,
      apiBaseUrl: getBackendBaseUrl(),
    }),
  ],
};
