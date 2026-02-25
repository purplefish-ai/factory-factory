import type { ServerInstance } from '@/backend/types/server-instance';

/**
 * Server Instance Service
 *
 * Provides global access to the server instance for retrieving runtime information
 * like the actual port the server is running on.
 */

export class ServerInstanceService {
  private serverInstance: ServerInstance | null = null;

  setInstance(instance: ServerInstance): void {
    this.serverInstance = instance;
  }

  getInstance(): ServerInstance | null {
    return this.serverInstance;
  }

  getPort(): number | null {
    return this.serverInstance?.getPort() ?? null;
  }
}

export function createServerInstanceService(): ServerInstanceService {
  return new ServerInstanceService();
}

export const serverInstanceService = createServerInstanceService();
