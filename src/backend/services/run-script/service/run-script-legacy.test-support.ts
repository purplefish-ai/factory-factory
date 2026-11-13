import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, vi, type Mock } from 'vitest';
import type { RunScriptTunnelLease } from './run-script-proxy.service';

export function captureShutdownHandlers(): {
  handlers: Map<string, (...args: unknown[]) => unknown>;
  processOnSpy: { mock: { calls: unknown[][] } };
} {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const processOnSpy = vi.spyOn(process, 'on').mockImplementation((event, handler) => {
    handlers.set(String(event), handler);
    return process;
  });
  return { handlers, processOnSpy };
}

export const mockSpawn: Mock = vi.fn();
export const mockTreeKill: Mock = vi.fn();
export const mockFindById: Mock = vi.fn();
export const mockStart: Mock = vi.fn();
export const mockBeginStopping: Mock = vi.fn();
export const mockCompleteStopping: Mock = vi.fn();
export const mockMarkCompleted: Mock = vi.fn();
export const mockMarkFailed: Mock = vi.fn();
export const mockMarkRunning: Mock = vi.fn();
export const mockReset: Mock = vi.fn();
export const mockVerifyRunning: Mock = vi.fn();
export const mockFindFreePort: Mock = vi.fn();
export const mockEnsureTunnel: Mock = vi.fn();
export const mockAcquireTunnel: Mock<
  (workspaceId: string, port: number) => Promise<RunScriptTunnelLease | null>
> = vi.fn();
export const mockStopTunnel: Mock = vi.fn();
export const mockGetTunnelUrl: Mock = vi.fn();
export const mockCleanupTunnels: Mock = vi.fn();
export const mockCleanupTunnelsSync: Mock = vi.fn();
export const mockReconcileWorkspaceCommandCache: Mock = vi.fn();

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
  PortAllocationService: {
    findFreePort: (...args: unknown[]) => mockFindFreePort(...args),
  },
}));

vi.mock('./run-script-proxy.service', () => ({
  runScriptProxyService: {
    acquireTunnel: (workspaceId: string, port: number) => mockAcquireTunnel(workspaceId, port),
    stopTunnel: (...args: unknown[]) => mockStopTunnel(...args),
    getTunnelUrl: (...args: unknown[]) => mockGetTunnelUrl(...args),
    cleanup: (...args: unknown[]) => mockCleanupTunnels(...args),
    cleanupSync: (...args: unknown[]) => mockCleanupTunnelsSync(...args),
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('./run-script-config-persistence.service', () => ({
  runScriptConfigPersistenceService: {
    reconcileWorkspaceCommandCache: (...args: unknown[]) =>
      mockReconcileWorkspaceCommandCache(...args),
  },
}));

import { RunScriptExecution } from './run-script-execution';
import { RunScriptOutputBuffer } from './run-script-output-buffer';
import type { RunScriptService } from './run-script.service';

export class FakeChildProcess extends EventEmitter {
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill: Mock<(signal?: NodeJS.Signals) => boolean> = vi.fn(() => {
    this.killed = true;
    return true;
  });

  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }
}

export const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

// Each file imports this module once; reset implementations as well as call
// history so a pending or rejected collaborator cannot leak into the next test.
beforeEach(() => {
  vi.resetAllMocks();
  mockTreeKill.mockImplementation(
    (_pid: number, _signal: string, callback: (error: Error | null) => void) => callback(null)
  );
  mockStart.mockResolvedValue(true);
  mockMarkRunning.mockResolvedValue(undefined);
  mockMarkCompleted.mockResolvedValue(undefined);
  mockMarkFailed.mockResolvedValue(undefined);
  mockCompleteStopping.mockResolvedValue(undefined);
  mockFindFreePort.mockResolvedValue(5173);
  mockEnsureTunnel.mockResolvedValue(null);
  mockAcquireTunnel.mockImplementation(async (workspaceId, port) => {
    const url = await mockEnsureTunnel(workspaceId, port);
    return url
      ? {
          url,
          release: async () => {
            await mockStopTunnel(workspaceId);
          },
        }
      : null;
  });
  mockSpawn.mockImplementation(() => new FakeChildProcess(12_345));
  mockReconcileWorkspaceCommandCache.mockImplementation(({ workspace }) => ({
    runScriptCommand: workspace.runScriptCommand,
    runScriptPostRunCommand: workspace.runScriptPostRunCommand,
    runScriptCleanupCommand: workspace.runScriptCleanupCommand,
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function asChild(child: object): ChildProcess {
  if (!('exitCode' in child)) {
    Object.assign(child, { exitCode: null });
  }
  if (!('signalCode' in child)) {
    Object.assign(child, { signalCode: null });
  }
  return child as ChildProcess;
}

/** A single local slot lets execution tests replace ownership without a service. */
export function createExecutionOwner(child?: object) {
  let current: RunScriptExecution | undefined;
  const runOutput = new RunScriptOutputBuffer(500 * 1024);
  const output: Mock<(value: string) => void> = vi.fn((value: string) =>
    runOutput.append('ws-1', value)
  );
  const postRunOutput: Mock<(value: string) => void> = vi.fn();
  const release: Mock<() => void> = vi.fn();
  const replace = (nextChild?: object) => {
    const execution = new RunScriptExecution('ws-1', {
      isCurrent: () => current === execution,
      release: () => {
        release();
        if (current === execution) {
          current = undefined;
        }
      },
      appendOutput: output,
      appendPostRunOutput: postRunOutput,
    });
    current = execution;
    if (nextChild) {
      execution.attachProcess(asChild(nextChild));
    }
    return execution;
  };
  const execution = replace(child);
  return {
    execution,
    replace,
    current: () => current,
    discard: () => {
      current = undefined;
    },
    runOutput,
    output,
    postRunOutput,
    release,
  };
}

// Stop/shutdown tests must seed existing owners without re-running admission.
// This is the only test boundary that reaches into the service's execution index.
export function serviceExecutions(service: RunScriptService) {
  return (service as unknown as { executions: Map<string, RunScriptExecution> }).executions;
}

export function installExecution(service: RunScriptService, workspaceId: string, child?: object) {
  const slots = serviceExecutions(service);
  const buffers = service as unknown as {
    runOutput: RunScriptOutputBuffer;
    postRunOutput: RunScriptOutputBuffer;
  };
  const execution = new RunScriptExecution(workspaceId, {
    isCurrent: () => slots.get(workspaceId) === execution,
    release: () => {
      if (slots.get(workspaceId) === execution) {
        slots.delete(workspaceId);
      }
    },
    appendOutput: (value) => buffers.runOutput.append(workspaceId, value),
    appendPostRunOutput: (value) => buffers.postRunOutput.append(workspaceId, value),
  });
  slots.set(workspaceId, execution);
  if (child) {
    execution.attachProcess(asChild(child));
  }
  return execution;
}

export async function spawnOwnedPostRun(execution: RunScriptExecution, child: object) {
  const spawned =
    'on' in child
      ? child
      : Object.assign(new FakeChildProcess((child as { pid: number }).pid), child);
  mockSpawn.mockReturnValueOnce(spawned);
  await execution.startPostRun('echo postrun', '/tmp/ws-1', undefined);
}

/** Feed workspace output through real start wiring and child streams. */
export async function createOutputWriters(service: RunScriptService, workspaceId: string) {
  const main = new FakeChildProcess(12_345);
  const postRun = new FakeChildProcess(88_888);
  mockFindById.mockResolvedValue({
    id: workspaceId,
    worktreePath: `/tmp/${workspaceId}`,
    runScriptCommand: 'echo main',
    runScriptPostRunCommand: 'echo postrun',
    runScriptCleanupCommand: null,
  });
  mockSpawn.mockReturnValueOnce(main).mockReturnValueOnce(postRun);
  await service.startRunScript(workspaceId);
  await flushMicrotasks();
  return {
    main: (value: string) => main.stdout.emit('data', Buffer.from(value)),
    postRun: (value: string) => postRun.stdout.emit('data', Buffer.from(value)),
  };
}

export { MockRunScriptStateMachineError };
