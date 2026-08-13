import { configService } from '@/backend/services/config.service';
import { serverInstanceService } from '@/backend/services/server-instance.service';
import { getChildWorkspaceMcpServerConfig } from '@/backend/services/session/service/acp/child-workspace-mcp-server';
import { userSettingsService } from '@/backend/services/settings';
import { sessionPromptBuilder } from './session.prompt-builder';
import { sessionRepository } from './session.repository';
import { SessionContextService } from './session-context.service';
import type { SessionAcpEnvironmentPort } from './session-lifecycle.types';

const ALL_INTERFACES_HOSTS = new Set(['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0']);

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
  const connectHost = ALL_INTERFACES_HOSTS.has(host) ? 'localhost' : host;
  const urlHost =
    connectHost.includes(':') && !connectHost.startsWith('[') ? `[${connectHost}]` : connectHost;
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
