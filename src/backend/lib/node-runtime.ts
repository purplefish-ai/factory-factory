import { configService } from '@/backend/services/config.service';

/**
 * Executable that launches bundled Node entrypoints (ACP adapters, provider
 * CLIs and the child-workspace MCP server).
 */
export function getNodeExecPath(): string {
  return configService.getNodeExecPath();
}
