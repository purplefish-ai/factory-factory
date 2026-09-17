import { configService } from '@/backend/services/config.service';
import { serverInstanceService } from '@/backend/services/server-instance.service';
import { getChildWorkspaceMcpServerConfig } from '@/backend/services/session/service/acp/child-workspace-mcp-server';
import { userSettingsService } from '@/backend/services/settings';
import { sessionRepository } from './session.repository';
import { SessionContextService } from './session-context.service';
import type { SessionAcpEnvironmentPort } from './session-lifecycle.types';

const ALL_INTERFACES_HOSTS = new Set(['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0']);

// Ratchet is non-interactive (no one can answer a permission prompt) and needs
// full write trust to fix issues, so it gets its own permission preset, which
// defaults to YOLO. Adversarial review is also non-interactive but is
// read-only by contract (see docs/design/adversarial-review.md) — it gets
// `defaultWorkspacePermissions` like any other session instead, and relies on
// the `plan` startup mode (adversarial-review.orchestrator.ts) to structurally
// block write tools rather than on being fully trusted.
const AUTONOMOUS_WORKFLOWS = new Set(['ratchet']);

export const sessionContextService = new SessionContextService({
  repository: sessionRepository,
  permissionPresetPort: {
    async getPermissionPreset(workflow) {
      const settings = await userSettingsService.get();
      return AUTONOMOUS_WORKFLOWS.has(workflow)
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
