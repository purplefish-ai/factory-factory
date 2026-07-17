import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { appGetPathMock } = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: appGetPathMock,
  },
}));

import { ServerManager } from './server-manager.js';

type ServerModuleImportShim = {
  dynamicImport: (moduleSpecifier: string) => Promise<unknown>;
};

type TestApplication = {
  services: {
    serverInstanceService: {
      setInstance: ReturnType<typeof vi.fn>;
    };
  };
};

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_RESOURCES_PATH = Object.getOwnPropertyDescriptor(process, 'resourcesPath');

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

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

function mockServerManagerImports(
  manager: ServerManager,
  createServer: (application: TestApplication) => {
    start(): Promise<string>;
    stop(): Promise<void>;
  },
  runMigrations: ReturnType<typeof vi.fn> = vi.fn()
) {
  const application: TestApplication = {
    services: {
      serverInstanceService: {
        setInstance: vi.fn(),
      },
    },
  };
  const createApplication = vi.fn(() => application);
  const disposeApplication = vi.fn().mockResolvedValue(undefined);
  const dynamicImportMock = vi.fn((modulePath: string) => {
    if (modulePath.endsWith('migrate.js')) {
      return Promise.resolve({ runMigrations });
    }
    if (modulePath.endsWith('server.js')) {
      return Promise.resolve({ createApplication, createServer, disposeApplication });
    }
    return Promise.reject(new Error(`Unexpected module path: ${modulePath}`));
  });

  (
    manager as unknown as {
      dynamicImport: <T>(modulePath: string) => Promise<T>;
      ensureDataDir: (databasePath: string) => void;
    }
  ).dynamicImport = dynamicImportMock;
  (
    manager as unknown as {
      dynamicImport: <T>(modulePath: string) => Promise<T>;
      ensureDataDir: (databasePath: string) => void;
    }
  ).ensureDataDir = vi.fn();

  return { application, createApplication, disposeApplication, dynamicImportMock, runMigrations };
}

describe('ServerManager module import behavior', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    setResourcesPath('/opt/Factory Factory/resources');
    appGetPathMock.mockReset();
    appGetPathMock.mockReturnValue('/tmp');
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
    const application: TestApplication = {
      services: {
        serverInstanceService: {
          setInstance: vi.fn(),
        },
      },
    };
    const createApplication = vi.fn(() => application);
    const disposeApplication = vi.fn().mockResolvedValue(undefined);

    const importSpy = vi.fn((moduleSpecifier: string) => {
      if (moduleSpecifier.includes('migrate.js')) {
        return Promise.resolve({ runMigrations });
      }
      if (moduleSpecifier.includes('server.js')) {
        return Promise.resolve({ createApplication, createServer, disposeApplication });
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
    expect(createApplication).toHaveBeenCalledOnce();
    expect(createServer).toHaveBeenCalledWith(application);
    expect(application.services.serverInstanceService.setInstance).toHaveBeenCalledWith(
      expect.objectContaining({ start: startServer })
    );
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
    expect(appGetPathMock).not.toHaveBeenCalled();
  });
});

describe('ServerManager lifecycle locking', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    setResourcesPath('/tmp/factory-factory-electron-resources');
    Reflect.deleteProperty(process.env, 'VITE_DEV_SERVER_URL');
    appGetPathMock.mockReset();
    appGetPathMock.mockReturnValue('/tmp/factory-factory-electron-tests');
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    restoreResourcesPath();
  });

  it('reuses a single startup when start is called concurrently', async () => {
    const manager = new ServerManager();
    const startGate = deferred<string>();
    const serverInstance = {
      start: vi.fn(() => startGate.promise),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const createServer = vi.fn(() => serverInstance);
    const { application, createApplication, runMigrations } = mockServerManagerImports(
      manager,
      createServer
    );

    const firstStart = manager.start();
    const secondStart = manager.start();

    await vi.waitFor(() => {
      expect(serverInstance.start).toHaveBeenCalledTimes(1);
    });
    expect(serverInstance.start).toHaveBeenCalledTimes(1);
    expect(createApplication).toHaveBeenCalledTimes(1);
    expect(createServer).toHaveBeenCalledTimes(1);
    expect(createServer).toHaveBeenCalledWith(application);
    expect(application.services.serverInstanceService.setInstance).toHaveBeenCalledWith(
      serverInstance
    );
    expect(runMigrations).toHaveBeenCalledTimes(1);

    startGate.resolve('http://localhost:4321');
    const [firstUrl, secondUrl] = await Promise.all([firstStart, secondStart]);

    expect(firstUrl).toBe('http://localhost:4321');
    expect(secondUrl).toBe('http://localhost:4321');
    expect(createServer).toHaveBeenCalledTimes(1);
  });

  it('disposes a composed application when server construction fails', async () => {
    const manager = new ServerManager();
    const constructionError = new Error('server construction failed');
    const createServer = vi.fn(() => {
      throw constructionError;
    });
    const { application, disposeApplication } = mockServerManagerImports(manager, createServer);

    await expect(manager.start()).rejects.toThrow(constructionError);

    expect(disposeApplication).toHaveBeenCalledWith(application);
    expect(application.services.serverInstanceService.setInstance).not.toHaveBeenCalled();
  });

  it('serializes stop and start so a new server is not clobbered', async () => {
    const manager = new ServerManager();
    const stopGate = deferred<void>();
    const firstServer = {
      start: vi.fn().mockResolvedValue('http://localhost:5001'),
      stop: vi.fn(() => stopGate.promise),
    };
    const secondServer = {
      start: vi.fn().mockResolvedValue('http://localhost:5002'),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const createServer = vi.fn().mockReturnValueOnce(firstServer).mockReturnValueOnce(secondServer);
    mockServerManagerImports(manager, createServer);

    await manager.start();

    const stopPromise = manager.stop();
    const restartPromise = manager.start();

    await Promise.resolve();
    expect(createServer).toHaveBeenCalledTimes(1);

    stopGate.resolve();
    await stopPromise;
    const restartUrl = await restartPromise;

    expect(restartUrl).toBe('http://localhost:5002');
    expect(createServer).toHaveBeenCalledTimes(2);

    await manager.stop();
    expect(firstServer.stop).toHaveBeenCalledTimes(1);
    expect(secondServer.stop).toHaveBeenCalledTimes(1);
  });

  it('returns cached server URL when start is called after already started', async () => {
    const manager = new ServerManager();
    const serverInstance = {
      start: vi.fn().mockResolvedValue('http://localhost:7001'),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const createServer = vi.fn(() => serverInstance);
    const { runMigrations } = mockServerManagerImports(manager, createServer);

    const firstUrl = await manager.start();
    const secondUrl = await manager.start();

    expect(firstUrl).toBe('http://localhost:7001');
    expect(secondUrl).toBe('http://localhost:7001');
    expect(createServer).toHaveBeenCalledTimes(1);
    expect(runMigrations).toHaveBeenCalledTimes(1);
  });

  it('clears cached server state when stop fails so the next start creates a new server', async () => {
    const manager = new ServerManager();
    const stopError = new Error('cleanup failed after server closed');
    const firstServer = {
      start: vi.fn().mockResolvedValue('http://localhost:8001'),
      stop: vi.fn().mockRejectedValue(stopError),
    };
    const secondServer = {
      start: vi.fn().mockResolvedValue('http://localhost:8002'),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const createServer = vi.fn().mockReturnValueOnce(firstServer).mockReturnValueOnce(secondServer);
    mockServerManagerImports(manager, createServer);

    const firstUrl = await manager.start();
    await expect(manager.stop()).rejects.toThrow(stopError);
    const secondUrl = await manager.start();

    expect(firstUrl).toBe('http://localhost:8001');
    expect(secondUrl).toBe('http://localhost:8002');
    expect(createServer).toHaveBeenCalledTimes(2);
    expect(firstServer.stop).toHaveBeenCalledTimes(1);
    expect(secondServer.start).toHaveBeenCalledTimes(1);
  });
});
