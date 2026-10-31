import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Export: spawn configuration for AcpRuntimeManager
// ---------------------------------------------------------------------------

/**
 * Returns the MCP server configuration to pass to newSession/loadSession for a
 * given workspace, or null if the feature is disabled (no FF_API_BASE_URL set).
 */
export function getChildWorkspaceMcpServerConfig(opts: {
  /** Executable that runs this file as a Node script. */
  nodeExecPath: string;
  workspaceId: string;
  parentWorkspaceId: string | null;
  apiBaseUrl: string;
}): { name: string; command: string; args: string[]; env: Record<string, string> } {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const entrypoint = fileURLToPath(
    new URL(`../../../../mcp/workspace-mcp-server.${extension}`, import.meta.url)
  );
  const context = JSON.stringify({
    workspaceId: opts.workspaceId,
    parentId: opts.parentWorkspaceId ?? '',
    apiBase: opts.apiBaseUrl,
  });
  return {
    name: 'factory-factory-child-workspace',
    command: opts.nodeExecPath,
    args: entrypoint.endsWith('.ts')
      ? ['--import', import.meta.resolve('tsx'), entrypoint, context]
      : [entrypoint, context],
    env: {
      // Codex passes MCP servers only a small env allowlist. Without this, the
      // Electron app binary would start a second desktop app instead of Node.
      ELECTRON_RUN_AS_NODE: '1',
      FF_CHILD_WORKSPACE_MCP: '1',
      FF_WORKSPACE_ID: opts.workspaceId,
      FF_WORKSPACE_PARENT_ID: opts.parentWorkspaceId ?? '',
      FF_API_BASE_URL: opts.apiBaseUrl,
      ...(entrypoint.endsWith('.ts')
        ? {
            TSX_TSCONFIG_PATH: fileURLToPath(
              new URL('../../../../../../tsconfig.json', import.meta.url)
            ),
          }
        : {}),
    },
  };
}
