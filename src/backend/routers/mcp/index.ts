import { createLogger } from '../../services/logger.service.js';
import { registerSystemTools } from './system.mcp.js';

const logger = createLogger('mcp');

/**
 * Initialize and register all MCP tools
 */
export function initializeMcpTools(): void {
  logger.info('Initializing MCP tools...');

  // Register remaining tool categories
  registerSystemTools();

  logger.info('MCP tools initialized successfully');
}

export * from './errors.js';
// Export everything from server
export * from './server.js';
export * from './types.js';
