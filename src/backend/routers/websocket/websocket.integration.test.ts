import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CIStatus,
  PRState,
  type PrismaClient,
  RatchetState,
  RunScriptStatus,
  SessionStatus,
  WorkspaceStatus,
} from '@prisma-gen/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { AppContext } from '@/backend/app-context';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import {
  closeWebSocket,
  connectWebSocket,
  createWebSocketTestServer,
  type WebSocketTestServer,
  waitForWebSocketMessage,
} from '@/backend/testing/websocket-test-utils';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

let db: IntegrationDatabase;
let prisma: PrismaClient;
let tempRootDir: string;

let createTerminalUpgradeHandler: typeof import('./terminal.handler').createTerminalUpgradeHandler;
let createDevLogsUpgradeHandler: typeof import('./dev-logs.handler').createDevLogsUpgradeHandler;
let createSnapshotsUpgradeHandler: typeof import('./snapshots.handler').createSnapshotsUpgradeHandler;
let createChatUpgradeHandler: typeof import('./chat.handler').createChatUpgradeHandler;

let terminalConnections: typeof import('./terminal.handler').terminalConnections;
let snapshotConnections: typeof import('./snapshots.handler').snapshotConnections;
let workspaceSnapshotStore: typeof import('@/backend/services').workspaceSnapshotStore;

let counter = 0;
const openServers = new Set<WebSocketTestServer>();
const openSockets = new Set<WebSocket>();

beforeAll(async () => {
  db = await createIntegrationDatabase();
  prisma = db.prisma;
  tempRootDir = mkdtempSync(join(tmpdir(), 'ff-ws-integration-'));

  ({ createTerminalUpgradeHandler, terminalConnections } =
    await vi.importActual<typeof import('./terminal.handler')>('./terminal.handler'));
  ({ createDevLogsUpgradeHandler } =
    await vi.importActual<typeof import('./dev-logs.handler')>('./dev-logs.handler'));
  ({ createSnapshotsUpgradeHandler, snapshotConnections } =
    await vi.importActual<typeof import('./snapshots.handler')>('./snapshots.handler'));
  ({ createChatUpgradeHandler } =
    await vi.importActual<typeof import('./chat.handler')>('./chat.handler'));
  ({ workspaceSnapshotStore } =
    await vi.importActual<typeof import('@/backend/services')>('@/backend/services'));
});

afterEach(async () => {
  for (const ws of openSockets) {
    await closeWebSocket(ws);
    openSockets.delete(ws);
  }

  for (const server of openServers) {
    await server.close();
    openServers.delete(server);
  }

  terminalConnections.clear();
  snapshotConnections.clear();
  workspaceSnapshotStore.clear();

  await clearIntegrationDatabase(prisma);
  vi.restoreAllMocks();
});

afterAll(async () => {
  rmSync(tempRootDir, { recursive: true, force: true });
  await destroyIntegrationDatabase(db);
});

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

async function createProjectFixture() {
  const slug = nextId('ws-project');
  return await prisma.project.create({
    data: {
      name: `Project ${slug}`,
      slug,
      repoPath: `/tmp/${slug}`,
      worktreeBasePath: `/tmp/worktrees/${slug}`,
    },
  });
}

async function createWorkspaceFixture(projectId: string, worktreePath: string) {
  return await prisma.workspace.create({
    data: {
      projectId,
      name: nextId('workspace'),
      status: WorkspaceStatus.READY,
      worktreePath,
    },
  });
}

class FakeTerminalService {
  private outputListeners = new Map<string, Set<(output: string) => void>>();
  private exitListeners = new Map<string, Set<(exitCode: number) => void>>();

  createTerminal = vi.fn(
    ({ workspaceId }: { workspaceId: string; workingDir: string; cols: number; rows: number }) =>
      Promise.resolve({ terminalId: `${workspaceId}-term-1`, pid: 4321 })
  );

  destroyTerminal = vi.fn();
  getTerminalsForWorkspace = vi.fn(
    () => [] as Array<{ id: string; createdAt: Date; outputBuffer: string }>
  );
  resizeTerminal = vi.fn();
  setActiveTerminal = vi.fn();
  writeToTerminal = vi.fn(() => true);

  onOutput = vi.fn((terminalId: string, callback: (output: string) => void) => {
    const listeners = this.outputListeners.get(terminalId) ?? new Set();
    listeners.add(callback);
    this.outputListeners.set(terminalId, listeners);
    return () => listeners.delete(callback);
  });

  onExit = vi.fn((terminalId: string, callback: (exitCode: number) => void) => {
    const listeners = this.exitListeners.get(terminalId) ?? new Set();
    listeners.add(callback);
    this.exitListeners.set(terminalId, listeners);
    return () => listeners.delete(callback);
  });

  emitOutput(terminalId: string, output: string): void {
    for (const callback of this.outputListeners.get(terminalId) ?? []) {
      callback(output);
    }
  }
}

class FakeRunScriptService {
  private subscribers = new Map<string, Set<(data: string) => void>>();
  private buffers = new Map<string, string>();

  setOutputBuffer(workspaceId: string, output: string): void {
    this.buffers.set(workspaceId, output);
  }

  getOutputBuffer = vi.fn((workspaceId: string) => this.buffers.get(workspaceId) ?? '');

  subscribeToOutput = vi.fn((workspaceId: string, callback: (data: string) => void) => {
    const listeners = this.subscribers.get(workspaceId) ?? new Set();
    listeners.add(callback);
    this.subscribers.set(workspaceId, listeners);

    return () => listeners.delete(callback);
  });

  emit(workspaceId: string, output: string): void {
    for (const callback of this.subscribers.get(workspaceId) ?? []) {
      callback(output);
    }
  }
}

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createChatAppContext(worktreeBaseDir: string) {
  const connections = new Map<
    string,
    { dbSessionId: string | null; workingDir: string | null; ws: WebSocket }
  >();

  const appContext = unsafeCoerce<AppContext>({
    services: {
      chatConnectionService: {
        values: () => connections.values(),
        get: (connectionId: string) => connections.get(connectionId),
        register: (
          connectionId: string,
          connectionInfo: { ws: WebSocket; dbSessionId: string | null; workingDir: string | null }
        ) => {
          connections.set(connectionId, connectionInfo);
        },
        unregister: (connectionId: string) => {
          connections.delete(connectionId);
        },
      },
      chatEventForwarderService: {
        setupClientEvents: vi.fn(),
        setupWorkspaceNotifications: vi.fn(),
      },
      chatMessageHandlerService: {
        handleMessage: vi.fn(),
        setClientCreator: vi.fn(),
        tryDispatchNextMessage: vi.fn(),
      },
      configService: {
        getDebugConfig: () => ({ chatWebSocket: false }),
        getWorktreeBaseDir: () => worktreeBaseDir,
      },
      createLogger: () => createLogger(),
      sessionFileLogger: {
        closeSession: vi.fn(),
        initSession: vi.fn(),
        log: vi.fn(),
      },
      sessionService: {
        getOrCreateClient: vi.fn(),
        getOrCreateSessionClient: vi.fn(),
        getSessionOptions: vi.fn(),
        setOnClientCreated: vi.fn(),
      },
    },
  });

  return appContext;
}

function waitForSocketError(ws: WebSocket): Promise<Error> {
  return new Promise((resolve) => {
    ws.once('error', (error) => resolve(error as Error));
  });
}

async function connectAndCaptureMessages(url: string): Promise<{
  messages: unknown[];
  ws: WebSocket;
}> {
  const messages: unknown[] = [];
  const ws = new WebSocket(url);
  ws.on('message', (data) => {
    const payload = Buffer.isBuffer(data) ? data.toString() : String(data);
    messages.push(JSON.parse(payload));
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (error) => reject(error));
  });

  return { ws, messages };
}

describe('websocket integration', () => {
  it('terminal handler supports create + output flow over a real websocket upgrade', async () => {
    const project = await createProjectFixture();
    const worktreePath = join(tempRootDir, nextId('worktree'));
    mkdirSync(worktreePath, { recursive: true });
    const workspace = await createWorkspaceFixture(project.id, worktreePath);

    const fakeTerminalService = new FakeTerminalService();

    const appContext = unsafeCoerce<AppContext>({
      services: {
        createLogger: () => createLogger(),
        terminalService: fakeTerminalService,
      },
    });

    const handler = createTerminalUpgradeHandler(appContext);
    const server = await createWebSocketTestServer(handler, '/terminal');
    openServers.add(server);

    const ws = await connectWebSocket(
      `ws://127.0.0.1:${server.port}/terminal?workspaceId=${workspace.id}`
    );
    openSockets.add(ws);

    ws.send(JSON.stringify({ type: 'create', cols: 100, rows: 30 }));

    const created = (await waitForWebSocketMessage(ws)) as { type: string; terminalId: string };
    expect(created).toEqual({ type: 'created', terminalId: `${workspace.id}-term-1` });

    expect(fakeTerminalService.createTerminal).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      workingDir: worktreePath,
      cols: 100,
      rows: 30,
    });

    const terminalSession = await prisma.terminalSession.findFirst({
      where: { workspaceId: workspace.id, name: `${workspace.id}-term-1` },
    });
    expect(terminalSession?.pid).toBe(4321);

    fakeTerminalService.emitOutput(`${workspace.id}-term-1`, 'hello from pty');
    const output = (await waitForWebSocketMessage(ws)) as {
      data: string;
      terminalId: string;
      type: string;
    };

    expect(output).toEqual({
      type: 'output',
      terminalId: `${workspace.id}-term-1`,
      data: 'hello from pty',
    });
  });

  it('terminal handler rejects websocket upgrades that omit workspaceId', async () => {
    const fakeTerminalService = new FakeTerminalService();
    const appContext = unsafeCoerce<AppContext>({
      services: {
        createLogger: () => createLogger(),
        terminalService: fakeTerminalService,
      },
    });

    const handler = createTerminalUpgradeHandler(appContext);
    const server = await createWebSocketTestServer(handler, '/terminal');
    openServers.add(server);

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/terminal`);
    const error = await waitForSocketError(ws);

    expect(error.message).toContain('Unexpected server response: 400');
  });

  it('dev-logs handler replays buffered output and streams live logs', async () => {
    const runScriptService = new FakeRunScriptService();
    const workspaceId = nextId('workspace');

    runScriptService.setOutputBuffer(workspaceId, 'buffered logs\n');

    const appContext = unsafeCoerce<AppContext>({
      services: {
        createLogger: () => createLogger(),
        runScriptService,
      },
    });

    const handler = createDevLogsUpgradeHandler(appContext);
    const server = await createWebSocketTestServer(handler, '/dev-logs');
    openServers.add(server);

    const { ws, messages } = await connectAndCaptureMessages(
      `ws://127.0.0.1:${server.port}/dev-logs?workspaceId=${workspaceId}`
    );
    openSockets.add(ws);

    await vi.waitFor(() => {
      expect(messages).toContainEqual({ type: 'output', data: 'buffered logs\n' });
    });

    runScriptService.emit(workspaceId, 'live logs\n');
    await vi.waitFor(() => {
      expect(messages).toContainEqual({ type: 'output', data: 'live logs\n' });
    });
  });

  it('snapshots handler sends full snapshot and emits change/remove deltas', async () => {
    workspaceSnapshotStore.configure({
      deriveFlowState: () => ({
        phase: 'NO_PR',
        ciObservation: 'CHECKS_UNKNOWN',
        isWorking: false,
        shouldAnimateRatchetButton: false,
      }),
      computeKanbanColumn: () => 'WORKING',
      deriveSidebarStatus: () => ({
        activityState: 'IDLE',
        ciState: 'NONE',
      }),
    });

    const workspaceId = nextId('workspace');
    const projectId = nextId('project');

    workspaceSnapshotStore.upsert(
      workspaceId,
      {
        projectId,
        name: 'Snapshot Workspace',
        status: WorkspaceStatus.READY,
        createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
        branchName: 'feature/test',
        prUrl: null,
        prNumber: null,
        prState: PRState.NONE,
        prCiStatus: CIStatus.UNKNOWN,
        prUpdatedAt: null,
        ratchetEnabled: false,
        ratchetState: RatchetState.IDLE,
        runScriptStatus: RunScriptStatus.IDLE,
        hasHadSessions: false,
        isWorking: false,
        pendingRequestType: null,
        gitStats: null,
        lastActivityAt: null,
      },
      'integration-test',
      Date.now()
    );

    const appContext = unsafeCoerce<AppContext>({
      services: {
        createLogger: () => createLogger(),
      },
    });

    const handler = createSnapshotsUpgradeHandler(appContext);
    const server = await createWebSocketTestServer(handler, '/snapshots');
    openServers.add(server);

    const { ws, messages } = await connectAndCaptureMessages(
      `ws://127.0.0.1:${server.port}/snapshots?projectId=${projectId}`
    );
    openSockets.add(ws);

    await vi.waitFor(() => {
      expect(messages).toContainEqual({
        type: 'snapshot_full',
        projectId,
        entries: expect.arrayContaining([expect.objectContaining({ workspaceId })]),
      });
    });

    workspaceSnapshotStore.upsert(
      workspaceId,
      {
        projectId,
        prUrl: 'https://github.com/acme/repo/pull/123',
        prState: PRState.OPEN,
      },
      'integration-test:update',
      Date.now() + 1000
    );

    await vi.waitFor(() => {
      expect(messages).toContainEqual({
        type: 'snapshot_changed',
        workspaceId,
        entry: expect.objectContaining({
          prUrl: 'https://github.com/acme/repo/pull/123',
        }),
      });
    });

    workspaceSnapshotStore.remove(workspaceId);

    await vi.waitFor(() => {
      expect(messages).toContainEqual({ type: 'snapshot_removed', workspaceId });
    });
  });

  it('chat handler rejects invalid websocket payloads with error message', async () => {
    const worktreeBaseDir = join(tempRootDir, nextId('chat-worktree-base'));
    mkdirSync(worktreeBaseDir, { recursive: true });

    const appContext = createChatAppContext(worktreeBaseDir);
    const handler = createChatUpgradeHandler(appContext);

    const server = await createWebSocketTestServer(handler, '/chat');
    openServers.add(server);

    const ws = await connectWebSocket(`ws://127.0.0.1:${server.port}/chat`);
    openSockets.add(ws);

    ws.send('{invalid-json');

    const message = (await waitForWebSocketMessage(ws)) as { message: string; type: string };
    expect(message).toEqual({ type: 'error', message: 'Invalid message format' });

    expect(appContext.services.chatMessageHandlerService.handleMessage).not.toHaveBeenCalled();
  });

  it('chat handler rejects workingDir path traversal at upgrade time', async () => {
    const worktreeBaseDir = join(tempRootDir, nextId('chat-worktree-base'));
    mkdirSync(worktreeBaseDir, { recursive: true });

    const appContext = createChatAppContext(worktreeBaseDir);
    const handler = createChatUpgradeHandler(appContext);

    const server = await createWebSocketTestServer(handler, '/chat');
    openServers.add(server);

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/chat?workingDir=../outside`);
    const error = await waitForSocketError(ws);

    expect(error.message).toContain('Unexpected server response: 400');
  });

  it('chat handler accepts valid workingDir inside configured worktree base', async () => {
    const worktreeBaseDir = join(tempRootDir, nextId('chat-worktree-base'));
    const validWorkingDir = join(worktreeBaseDir, 'workspace-1');
    mkdirSync(validWorkingDir, { recursive: true });

    const appContext = createChatAppContext(worktreeBaseDir);
    const handler = createChatUpgradeHandler(appContext);
    const normalizedWorkingDir = realpathSync(validWorkingDir);

    const server = await createWebSocketTestServer(handler, '/chat');
    openServers.add(server);

    const ws = await connectWebSocket(
      `ws://127.0.0.1:${server.port}/chat?workingDir=${encodeURIComponent(validWorkingDir)}`
    );
    openSockets.add(ws);

    ws.send(JSON.stringify({ type: 'list_sessions' }));

    await vi.waitFor(() => {
      expect(appContext.services.chatMessageHandlerService.handleMessage).toHaveBeenCalledWith(
        expect.any(Object),
        null,
        normalizedWorkingDir,
        { type: 'list_sessions' }
      );
    });
  });

  it('terminal create flow stores terminal sessions that can be queried by accessor', async () => {
    const project = await createProjectFixture();
    const worktreePath = join(tempRootDir, nextId('worktree'));
    mkdirSync(worktreePath, { recursive: true });
    const workspace = await createWorkspaceFixture(project.id, worktreePath);

    const fakeTerminalService = new FakeTerminalService();
    const appContext = unsafeCoerce<AppContext>({
      services: {
        createLogger: () => createLogger(),
        terminalService: fakeTerminalService,
      },
    });

    const handler = createTerminalUpgradeHandler(appContext);
    const server = await createWebSocketTestServer(handler, '/terminal');
    openServers.add(server);

    const ws = await connectWebSocket(
      `ws://127.0.0.1:${server.port}/terminal?workspaceId=${workspace.id}`
    );
    openSockets.add(ws);

    ws.send(JSON.stringify({ type: 'create' }));
    await waitForWebSocketMessage(ws);

    const sessions = await prisma.terminalSession.findMany({
      where: { workspaceId: workspace.id },
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe(SessionStatus.IDLE);
  });
});
