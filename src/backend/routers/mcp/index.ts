import { registerAgentTools } from './agent.mcp.js';
import { registerEpicTools } from './epic.mcp.js';
import { registerGitTools } from './git.mcp.js';
import { registerMailTools } from './mail.mcp.js';
import { registerOrchestratorTools } from './orchestrator.mcp.js';
import { registerSystemTools } from './system.mcp.js';
import { registerTaskTools } from './task.mcp.js';

/**
 * Initialize and register all MCP tools
 */
export function initializeMcpTools(): void {
  console.log('Initializing MCP tools...');

  // Register all tool categories
  registerMailTools();
  registerAgentTools();
  registerSystemTools();
  registerTaskTools();
  registerGitTools();
  registerEpicTools();
  registerOrchestratorTools();

  console.log('MCP tools initialized successfully');
}

export * from './errors.js';
export * from './permissions.js';
// Export everything from server
export * from './server.js';
export * from './types.js';
