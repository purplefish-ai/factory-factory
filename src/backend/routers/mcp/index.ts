import { createLogger } from '../../services/logger.service';
import { registerLockTools } from './lock.mcp';
import { registerSystemTools } from './system.mcp';

const logger = createLogger('mcp');

/**
 * Initialize and register all MCP tools
 */
export function initializeMcpTools(): void {
  logger.info('Initializing MCP tools...');

  // Register tool categories
  registerSystemTools();
  registerLockTools();

  logger.info('MCP tools initialized successfully');
}

export * from './errors';
// Export everything from server
export * from './server';
export * from './types';
