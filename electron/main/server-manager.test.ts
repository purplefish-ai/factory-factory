import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAppGetPath } = vi.hoisted(() => ({
  mockAppGetPath: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: mockAppGetPath,
  },
}));

import { ServerManager } from './server-manager';

type ServerModuleImportShim = {
  dynamicImport: (moduleSpecifier: string) => Promise<unknown>;
};

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_RESOURCES_PATH = Object.getOwnPropertyDescriptor(process, 'resourcesPath');

const setResourcesPath = (resourcesPath: string) => {
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: resourcesPath,
    writable: true,
  });
};

const restoreResourcesPath = () => {
  if (ORIGINAL_RESOURCES_PATH) {
    Object.defineProperty(process, 'resourcesPath', ORIGINAL_RESOURCES_PATH);
    return;
  }

  Reflect.deleteProperty(process, 'resourcesPath');
};

describe('ServerManager', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    setResourcesPath('/opt/Factory Factory/resources');
    mockAppGetPath.mockReset();
    mockAppGetPath.mockReturnValue('/tmp');
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    restoreResourcesPath();
  });

  it('imports backend modules from app.asar.unpacked using file URLs', async () => {
    const runMigrations = vi.fn();
    const startServer = vi.fn().mockResolvedValue('http://127.0.0.1:4311');
    const createServer = vi.fn(() => ({
      start: startServer,
      stop: vi.fn().mockResolvedValue(undefined),
    }));

    const importSpy = vi.fn((moduleSpecifier: string) => {
      if (moduleSpecifier.includes('migrate.js')) {
        return Promise.resolve({ runMigrations });
      }
      if (moduleSpecifier.includes('server.js')) {
        return Promise.resolve({ createServer });
      }
      return Promise.reject(new Error(`Unexpected module import: ${moduleSpecifier}`));
    });

    const manager = new ServerManager();
    (manager as unknown as ServerModuleImportShim).dynamicImport = importSpy;

    const url = await manager.start();

    const backendDistPath = join(
      process.resourcesPath,
      'app.asar.unpacked',
      'dist',
      'src',
      'backend'
    );
    const expectedMigrateUrl = pathToFileURL(join(backendDistPath, 'migrate.js')).href;
    const expectedServerUrl = pathToFileURL(join(backendDistPath, 'server.js')).href;

    expect(url).toBe('http://127.0.0.1:4311');
    expect(importSpy).toHaveBeenNthCalledWith(1, expectedMigrateUrl);
    expect(importSpy).toHaveBeenNthCalledWith(2, expectedServerUrl);
    expect(runMigrations).toHaveBeenCalledWith({
      databasePath: '/tmp/data.db',
      migrationsPath: join(process.resourcesPath, 'prisma', 'migrations'),
      log: expect.any(Function),
    });
    expect(process.env.FRONTEND_STATIC_PATH).toBe(
      join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'client')
    );
  });

  it('returns vite dev server URL without importing backend modules', async () => {
    process.env.VITE_DEV_SERVER_URL = 'http://localhost:5173';
    const manager = new ServerManager();
    const importSpy = vi.fn();
    (manager as unknown as ServerModuleImportShim).dynamicImport = importSpy;

    const url = await manager.start();

    expect(url).toBe('http://localhost:5173');
    expect(importSpy).not.toHaveBeenCalled();
    expect(mockAppGetPath).not.toHaveBeenCalled();
  });
});
