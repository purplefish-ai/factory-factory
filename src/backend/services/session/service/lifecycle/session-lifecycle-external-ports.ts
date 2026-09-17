import { configService } from '@/backend/services/config.service';
import { serverInstanceService } from '@/backend/services/server-instance.service';
import { getChildWorkspaceMcpServerConfig } from '@/backend/services/session/service/acp/child-workspace-mcp-server';
import { userSettingsService } from '@/backend/services/settings';
import { sessionRepository } from './session.repository';
import { SessionContextService } from './session-context.service';
import type { SessionAcpEnvironmentPort } from './session-lifecycle.types';
import { getWorkflowPermissionPreset } from './session-workflow-permissions';

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

// Ratchet and auto-iteration are non-interactive (no one can answer a
// permission prompt) and need full write trust to fix issues, so they get the
// ratchet permission preset, which defaults to YOLO (see
// getWorkflowPermissionPreset). Adversarial review is also non-interactive but
// is read-only by contract (see docs/design/adversarial-review.md) — it falls
// through to `defaultWorkspacePermissions` like any other session, and relies
// on the `plan` startup mode (adversarial-review.orchestrator.ts) to
// structurally block write tools rather than on being fully trusted.
export const sessionContextService = new SessionContextService({
  repository: sessionRepository,
  permissionPresetPort: {
    async getPermissionPreset(workflow) {
      const settings = await userSettingsService.get();
      return getWorkflowPermissionPreset(workflow, settings);
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
