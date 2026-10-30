/**
 * Backend Server Entry Point (CLI/Standalone Mode)
 *
 * This is the entry point for running the backend as a standalone server
 * (via CLI or direct node execution). The desktop app forks
 * './electron-utility-entry.ts' in an Electron utility process instead.
 *
 * Configuration is read from environment variables:
 * - DATABASE_PATH: SQLite database file path
 * - FRONTEND_STATIC_PATH: Path to frontend build (optional)
 * - BACKEND_PORT: Server port (default: 3001)
 * - NODE_ENV: Environment (development/production)
 */

import 'dotenv/config';
import { createApplication } from './app-context';
import { registerFatalErrorHandlers } from './fatal-error-handlers';
import { toError } from './lib/error-utils';
import { createServer } from './server';
import { registerShutdownSignalHandlers } from './shutdown-signal-handlers';

const application = createApplication();
const logger = application.services.createLogger('server');

// Create and start the server
const serverInstance = createServer(application);

// Register the server instance globally for access by tRPC endpoints
application.services.serverInstanceService.setInstance(serverInstance);

serverInstance.start().catch((error) => {
  logger.error('Failed to start server', toError(error));
  process.exit(1);
});

registerShutdownSignalHandlers({ logger, process, server: serverInstance });

registerFatalErrorHandlers({ logger, process, server: serverInstance });
