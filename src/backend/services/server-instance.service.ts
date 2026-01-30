/**
 * Server Instance Service
 *
 * Provides global access to the server instance for retrieving runtime information
 * like the actual port the server is running on.
 *
 * Uses any type to avoid circular dependency with server.ts
 */

// biome-ignore lint/suspicious/noExplicitAny: Avoiding circular dependency with server.ts
let serverInstance: any = null;

export const serverInstanceService = {
  // biome-ignore lint/suspicious/noExplicitAny: Avoiding circular dependency with server.ts
  setInstance(instance: any): void {
    serverInstance = instance;
  },

  // biome-ignore lint/suspicious/noExplicitAny: Avoiding circular dependency with server.ts
  getInstance(): any {
    return serverInstance;
  },

  getPort(): number | null {
    return serverInstance?.getPort() ?? null;
  },
};
