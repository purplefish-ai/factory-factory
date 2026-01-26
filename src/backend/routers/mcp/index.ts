import { createLogger } from '../../services/logger.service';
import { registerSystemTools } from './system.mcp';

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

export * from './errors';
// Export everything from server
export * from './server';
export * from './types';
