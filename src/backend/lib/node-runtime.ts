import { configService } from '@/backend/services/config.service';

/**
 * Executable that launches bundled Node entrypoints (ACP adapters, provider
 * CLIs and the child-workspace MCP server). Under Electron, callers also set
 * ELECTRON_RUN_AS_NODE=1.
 */
export function getNodeExecPath(): string {
  return configService.getNodeExecPath();
}
