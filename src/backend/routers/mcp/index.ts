import { registerMailTools } from "./mail.mcp.js";
import { registerAgentTools } from "./agent.mcp.js";
import { registerSystemTools } from "./system.mcp.js";
import { registerTaskTools } from "./task.mcp.js";
import { registerGitTools } from "./git.mcp.js";

/**
 * Initialize and register all MCP tools
 */
export function initializeMcpTools(): void {
  console.log("Initializing MCP tools...");

  // Register all tool categories
  registerMailTools();
  registerAgentTools();
  registerSystemTools();
  registerTaskTools();
  registerGitTools();

  console.log("MCP tools initialized successfully");
}

// Export everything from server
export * from "./server.js";
export * from "./types.js";
export * from "./permissions.js";
export * from "./errors.js";
