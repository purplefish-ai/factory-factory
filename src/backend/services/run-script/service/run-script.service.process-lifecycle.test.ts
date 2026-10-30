import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.fn();
const mockTreeKill = vi.fn();
const mockFindById = vi.fn();
const mockStart = vi.fn();
const mockBeginStopping = vi.fn();
const mockCompleteStopping = vi.fn();
const mockMarkCompleted = vi.fn();
const mockMarkFailed = vi.fn();
const mockMarkRunning = vi.fn();
const mockReset = vi.fn();
const mockVerifyRunning = vi.fn();
const mockReconcileWorkspaceCommandCache = vi.fn();
const mockFindFreePort = vi.fn();
const mockEnsureTunnel = vi.fn();

const MockRunScriptStateMachineError = vi.hoisted(
  () =>
    class extends Error {
      constructor(
        readonly workspaceId: string,
        readonly fromStatus: string,
        readonly toStatus: string
      ) {
        super(`Invalid run script state transition: ${fromStatus} -> ${toStatus}`);
        this.name = 'RunScriptStateMachineError';
      }
    }
);

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock('tree-kill', () => ({
  default: (...args: unknown[]) => mockTreeKill(...args),
}));

vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: {
    findById: (...args: unknown[]) => mockFindById(...args),
  },
}));

vi.mock('./run-script-state-machine.service', () => ({
  RunScriptStateMachineError: MockRunScriptStateMachineError,
  runScriptStateMachine: {
    start: (...args: unknown[]) => mockStart(...args),
    beginStopping: (...args: unknown[]) => mockBeginStopping(...args),
    completeStopping: (...args: unknown[]) => mockCompleteStopping(...args),
    markCompleted: (...args: unknown[]) => mockMarkCompleted(...args),
    markFailed: (...args: unknown[]) => mockMarkFailed(...args),
    markRunning: (...args: unknown[]) => mockMarkRunning(...args),
    reset: (...args: unknown[]) => mockReset(...args),
    verifyRunning: (...args: unknown[]) => mockVerifyRunning(...args),
  },
}));

vi.mock('./port-allocation.service', () => ({
  PortAllocationService: { findFreePort: (...args: unknown[]) => mockFindFreePort(...args) },
}));

vi.mock('./run-script-proxy.service', () => ({
  runScriptProxyService: {
    ensureTunnel: (...args: unknown[]) => mockEnsureTunnel(...args),
    stopTunnel: vi.fn(() => Promise.resolve()),
    getTunnelUrl: vi.fn(),
    cleanup: vi.fn(),
    cleanupSync: vi.fn(),
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('./run-script-config-persistence.service', () => ({
  runScriptConfigPersistenceService: {
    reconcileWorkspaceCommandCache: (...args: unknown[]) =>
      mockReconcileWorkspaceCommandCache(...args),
  },
}));

import { RunScriptService } from './run-script.service';

class FakeChildProcess extends EventEmitter {
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });

  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }
}

const COMMANDS = {
  runScriptCommand: 'pnpm dev',
  runScriptPostRunCommand: null,
  runScriptCleanupCommand: null,
};

describe('RunScriptService process lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReconcileWorkspaceCommandCache.mockResolvedValue(COMMANDS);
    mockStart.mockResolvedValue({ runScriptStatus: 'STARTING' });
    mockMarkRunning.mockResolvedValue({ runScriptStatus: 'RUNNING' });
    mockMarkFailed.mockResolvedValue({ runScriptStatus: 'FAILED' });
    mockBeginStopping.mockResolvedValue({ runScriptStatus: 'STOPPING' });
    mockCompleteStopping.mockResolvedValue({ runScriptStatus: 'IDLE' });
  });

  // Node's spawn() reports ENOENT/EACCES/EAGAIN/EMFILE by returning a child with
  // no pid and emitting 'error' on the next tick. Without a listener, that emit is
  // an uncaught exception that the backend's fatal handler turns into a shutdown.
  it('keeps an error listener on a run-script child that failed to spawn', async () => {
    const child = new FakeChildProcess(undefined);
    mockSpawn.mockReturnValue(child);
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      worktreePath: '/tmp/ws-1',
      runScriptStatus: 'STARTING',
      ...COMMANDS,
    });

    const result = await new RunScriptService().startRunScript('ws-1');
    expect(result.success).toBe(false);

    // This is what Node does on process.nextTick after a failed spawn.
    expect(() =>
      child.emit('error', Object.assign(new Error('spawn bash ENOENT'), { code: 'ENOENT' }))
    ).not.toThrow();
  });

  it('keeps an error listener on a postRun child that failed to spawn', async () => {
    mockReconcileWorkspaceCommandCache.mockResolvedValue({
      ...COMMANDS,
      runScriptPostRunCommand: 'cloudflared tunnel',
    });
    const runChild = new FakeChildProcess(1001);
    const postRunChild = new FakeChildProcess(undefined);
    mockSpawn.mockReturnValueOnce(runChild).mockReturnValueOnce(postRunChild);
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      worktreePath: '/tmp/ws-1',
      runScriptStatus: 'IDLE',
      ...COMMANDS,
    });

    await expect(new RunScriptService().startRunScript('ws-1')).resolves.toMatchObject({
      success: true,
    });
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));

    expect(() =>
      postRunChild.emit('error', Object.assign(new Error('spawn bash EAGAIN'), { code: 'EAGAIN' }))
    ).not.toThrow();
  });

  // The dev-logs WebSocket (push-channel.handler.ts) subscribes once per
  // connection and keeps the socket open across runs, so stopping must not drop
  // its subscription.
  it('streams output from a restarted run script to an existing subscriber', async () => {
    const service = new RunScriptService();
    const listener = vi.fn();
    service.subscribeToOutput('ws-1', listener);

    // First run.
    const firstChild = new FakeChildProcess(1001);
    mockSpawn.mockReturnValueOnce(firstChild);
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      worktreePath: '/tmp/ws-1',
      runScriptStatus: 'IDLE',
      runScriptPid: null,
      runScriptPort: null,
      ...COMMANDS,
    });
    await expect(service.startRunScript('ws-1')).resolves.toMatchObject({ success: true });
    firstChild.stdout.emit('data', Buffer.from('first run output\n'));
    expect(listener).toHaveBeenCalledWith('first run output\n');

    // User clicks Stop.
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      worktreePath: '/tmp/ws-1',
      runScriptStatus: 'RUNNING',
      runScriptPid: 1001,
      runScriptPort: null,
      ...COMMANDS,
    });
    mockTreeKill.mockImplementation(
      (_pid: number, _signal: string, callback: (error: Error | null) => void) => {
        firstChild.signalCode = 'SIGTERM';
        callback(null);
      }
    );
    await expect(service.stopRunScript('ws-1')).resolves.toEqual({ success: true });

    // User clicks Start again; the dev-logs socket never disconnected.
    const secondChild = new FakeChildProcess(2002);
    mockSpawn.mockReturnValueOnce(secondChild);
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      worktreePath: '/tmp/ws-1',
      runScriptStatus: 'IDLE',
      runScriptPid: null,
      runScriptPort: null,
      ...COMMANDS,
    });
    await expect(service.startRunScript('ws-1')).resolves.toMatchObject({ success: true });
    secondChild.stdout.emit('data', Buffer.from('second run output\n'));

    expect(listener).toHaveBeenCalledWith('second run output\n');
  });

  // A stop while the tunnel is starting finds no postRun process to kill, so a
  // postRun spawned afterwards would run untracked until the server shuts down.
  it('does not spawn the postRun script after the run script was stopped', async () => {
    const service = new RunScriptService();
    const commands = {
      runScriptCommand: 'pnpm dev --port {port}',
      runScriptPostRunCommand: 'pnpm watch:assets',
      runScriptCleanupCommand: null,
    };
    mockReconcileWorkspaceCommandCache.mockResolvedValue(commands);
    mockFindFreePort.mockResolvedValue(4100);
    let resolveTunnel!: (url: string | null) => void;
    mockEnsureTunnel.mockReturnValue(
      new Promise<string | null>((resolve) => {
        resolveTunnel = resolve;
      })
    );
    const runChild = new FakeChildProcess(1001);
    const postRunChild = new FakeChildProcess(3003);
    mockSpawn.mockReturnValueOnce(runChild).mockReturnValueOnce(postRunChild);
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      worktreePath: '/tmp/ws-1',
      runScriptStatus: 'IDLE',
      runScriptPid: null,
      runScriptPort: null,
      ...commands,
    });

    const startPromise = service.startRunScript('ws-1');
    await vi.waitFor(() => expect(mockEnsureTunnel).toHaveBeenCalledWith('ws-1', 4100));

    // User clicks Stop while the tunnel is still coming up.
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      worktreePath: '/tmp/ws-1',
      runScriptStatus: 'RUNNING',
      runScriptPid: 1001,
      runScriptPort: 4100,
      ...commands,
    });
    mockTreeKill.mockImplementation(
      (_pid: number, _signal: string, callback: (error: Error | null) => void) => {
        runChild.signalCode = 'SIGTERM';
        callback(null);
      }
    );
    await expect(service.stopRunScript('ws-1')).resolves.toEqual({ success: true });

    resolveTunnel('https://example.trycloudflare.com');
    await startPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Only the (now stopped) run script should ever have been spawned.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});
