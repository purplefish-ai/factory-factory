import type { ServerInstance } from '@/backend/server';

/**
 * Server Instance Service
 *
 * Provides global access to the server instance for retrieving runtime information
 * like the actual port the server is running on.
 */

let serverInstance: ServerInstance | null = null;

export const serverInstanceService = {
  setInstance(instance: ServerInstance): void {
    serverInstance = instance;
  },

  getInstance(): ServerInstance | null {
    return serverInstance;
  },

  getPort(): number | null {
    return serverInstance?.getPort() ?? null;
  },
};
