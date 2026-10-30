/**
 * Backend entry point for the desktop app.
 *
 * Electron main forks this file with `utilityProcess.fork()`, so backend work
 * (synchronous SQLite, agent streams, terminals) runs off the UI process.
 * Electron main sets DATABASE_PATH, MIGRATIONS_PATH, FRONTEND_STATIC_PATH,
 * WS_LOGS_PATH, NODE_ENV and FF_NODE_EXEC_PATH in the fork environment.
 * The protocol with Electron main lives in `electron-utility-backend.ts`.
 */

import { createApplication, disposeApplication } from './app-context';
import { type ParentPortLike, runElectronUtilityBackend } from './electron-utility-backend';
import { toError } from './lib/error-utils';
import { runMigrations } from './migrate';
import { createServer } from './server';
import { configService } from './services/config.service';
import { createLogger } from './services/logger.service';

const logger = createLogger('electron-backend');

function isParentPortLike(value: unknown): value is ParentPortLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'on') === 'function' &&
    typeof Reflect.get(value, 'postMessage') === 'function'
  );
}

const parentPort: unknown = Reflect.get(process, 'parentPort');
if (!isParentPortLike(parentPort)) {
  throw new Error('electron-utility-entry must run in an Electron utility process');
}

void runElectronUtilityBackend({
  parentPort,
  process,
  logger,
  migrate: () => {
    const migrationsPath = configService.getMigrationsPath();
    if (!migrationsPath) {
      throw new Error('MIGRATIONS_PATH is required for the desktop backend');
    }
    runMigrations({ databasePath: configService.getDatabasePath(), migrationsPath });
  },
  createServer: async () => {
    const application = createApplication();
    try {
      const server = createServer(application);
      application.services.serverInstanceService.setInstance(server);
      return server;
    } catch (error) {
      await disposeApplication(application).catch((disposeError: unknown) => {
        logger.error(
          'Failed to dispose application after server creation error',
          toError(disposeError)
        );
      });
      throw error;
    }
  },
});
