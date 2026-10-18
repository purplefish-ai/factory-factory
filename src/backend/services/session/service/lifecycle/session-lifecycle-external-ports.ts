import { configService } from '@/backend/services/config.service';
import { serverInstanceService } from '@/backend/services/server-instance.service';
import { getChildWorkspaceMcpServerConfig } from '@/backend/services/session/service/acp/child-workspace-mcp-server';
import { userSettingsService } from '@/backend/services/settings';
import { SessionContextService } from './session-context.service';
import type { SessionAcpEnvironmentPort } from './session-lifecycle.types';
import { getWorkflowPermissionPreset } from './session-workflow-permissions';
import { sessionRepository } from './session.repository';

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

// Auto-iteration uses its configured permission preset. Scheduled Codex tasks
// use YOLO so approval prompts cannot stall headless runs; other scheduled
// providers retain workspace permissions (see getWorkflowPermissionPreset).
// Adversarial review is also non-interactive but
// is read-only by contract (see docs/design/adversarial-review.md) — it falls
// through to `defaultWorkspacePermissions`. Lifecycle startup independently
// enforces plan mode and Codex read-only execution, and its permission bridge
// denies permission escalation even if the configured preset is permissive.
export const sessionContextService = new SessionContextService({
  repository: sessionRepository,
  permissionPresetPort: {
    async getPermissionPreset(workflow, provider) {
      const settings = await userSettingsService.get();
      return getWorkflowPermissionPreset(workflow, provider, settings);
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
