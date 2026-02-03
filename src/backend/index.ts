/**
 * Backend Server Entry Point (CLI/Standalone Mode)
 *
 * This is the entry point for running the backend as a standalone server
 * (via CLI or direct node execution). For Electron integration, import
 * createServer from './server.ts' instead.
 *
 * Configuration is read from environment variables:
 * - DATABASE_PATH: SQLite database file path
 * - FRONTEND_STATIC_PATH: Path to frontend build (optional)
 * - BACKEND_PORT: Server port (default: 3001)
 * - NODE_ENV: Environment (development/production)
 */

import 'dotenv/config';
import { createAppContext } from './app-context';
import { createServer } from './server';

const appContext = createAppContext();
const logger = appContext.services.createLogger('server');

// Create and start the server
const serverInstance = createServer(undefined, appContext);

// Register the server instance globally for access by tRPC endpoints
appContext.services.serverInstanceService.setInstance(serverInstance);

serverInstance.start().catch((error) => {
  logger.error('Failed to start server', error as Error);
  process.exit(1);
});

// Graceful shutdown handlers
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await serverInstance.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await serverInstance.stop();
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
  logger.error('Uncaught exception', error);
  try {
    await serverInstance.stop();
  } catch {
    // Ignore cleanup errors
  }
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection at promise', { reason, promise });
});
