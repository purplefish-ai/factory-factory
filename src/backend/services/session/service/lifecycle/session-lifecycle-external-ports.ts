import { configService } from '@/backend/services/config.service';
import { serverInstanceService } from '@/backend/services/server-instance.service';
import { getChildWorkspaceMcpServerConfig } from '@/backend/services/session/service/acp/child-workspace-mcp-server';
import { userSettingsService } from '@/backend/services/settings';
import { sessionRepository } from './session.repository';
import { SessionContextService } from './session-context.service';
import type { SessionAcpEnvironmentPort } from './session-lifecycle.types';

function isWildcardHost(host: string): boolean {
  if (host === '0.0.0.0') {
    return true;
  }
  if (!host.includes(':')) {
    return false;
  }
  const urlHost = host.startsWith('[') ? host : `[${host}]`;
  return URL.canParse(`http://${urlHost}`) && new URL(`http://${urlHost}`).hostname === '[::]';
}

export const sessionContextService = new SessionContextService({
  repository: sessionRepository,
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
  const connectHost = isWildcardHost(host) ? 'localhost' : host;
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
