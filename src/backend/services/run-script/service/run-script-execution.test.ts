import { ChildProcess } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceDataService } from '@/backend/services/workspace';
import { RunScriptExecution } from './run-script-execution';
import { spawnPipedShellCommand } from './run-script-process-utils';
import { runScriptStateMachine } from './run-script-state-machine.service';

vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: { findById: vi.fn() },
}));

vi.mock('./run-script-state-machine.service', () => ({
  RunScriptStateMachineError: class extends Error {},
  runScriptStateMachine: {
    markRunning: vi.fn(),
    markCompleted: vi.fn(),
    markFailed: vi.fn(),
    completeStopping: vi.fn(),
  },
}));

vi.mock('./run-script-process-utils', () => ({
  decodeOutputStream: vi.fn(),
  spawnPipedShellCommand: vi.fn(),
  treeKillProcess: vi.fn(),
  waitForChildProcessExit: vi.fn(),
}));

vi.mock('./run-script-proxy.service', () => ({
  runScriptProxyService: { acquireTunnel: vi.fn() },
}));

function execution() {
  const release = vi.fn();
  const isCurrent = vi.fn(() => true);
  const owner = new RunScriptExecution('ws-1', {
    isCurrent,
    release,
    appendOutput: vi.fn(),
    appendPostRunOutput: vi.fn(),
  });
  return { owner, release, isCurrent };
}

function childProcess(
  params: {
    killed?: boolean;
    exitCode?: number | null;
    signalCode?: NodeJS.Signals | null;
  } = {}
) {
  const child = new ChildProcess();
  Object.defineProperties(child, {
    pid: { value: 1234 },
    killed: { value: params.killed ?? false },
    exitCode: { value: params.exitCode ?? null },
    signalCode: { value: params.signalCode ?? null },
    kill: { value: vi.fn() },
  });
  return child;
}

describe('RunScriptExecution ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workspaceDataService.findById).mockResolvedValue({
      runScriptStatus: 'STARTING',
    } as Awaited<ReturnType<typeof workspaceDataService.findById>>);
  });

  it('revokes permission to spawn as soon as stop is requested', () => {
    const { owner } = execution();
    expect(owner.canSpawn).toBe(true);
    owner.requestStop();
    expect(owner.canSpawn).toBe(false);
  });

  it('rejects attaching a child after the attempt has been stopped', () => {
    const { owner } = execution();
    owner.requestStop();
    expect(() => owner.attachProcess(new ChildProcess())).toThrow('stopped');
  });

  it('keeps process observation separate from stop intent', () => {
    const { owner } = execution();
    const child = new ChildProcess();
    Object.defineProperty(child, 'pid', { value: 1234 });
    owner.attachProcess(child);
    owner.requestStop();
    expect(owner.process).toBe(child);
    expect(owner.canStartAuxiliary).toBe(false);
    expect(owner.observation.kind).toBe('live');
  });

  it('does not persist an ended owner into a replacement STARTING admission', async () => {
    const { owner, isCurrent } = execution();
    let current = owner;
    isCurrent.mockImplementation(() => current === owner);
    owner.attachProcess(childProcess());
    await owner.observeExit(0, null);
    const replacement = execution().owner;
    current = replacement;

    const result = await owner.finishStartup(1234, 3000, null, '/tmp');

    expect(result).toEqual({ success: true, pid: 1234, port: 3000 });
    expect(runScriptStateMachine.markRunning).not.toHaveBeenCalled();
    expect(replacement.canSpawn).toBe(true);
  });

  it('does not persist startup after the current owner is revoked', async () => {
    const { owner, isCurrent } = execution();
    owner.attachProcess(childProcess());
    isCurrent.mockReturnValue(false);

    const result = await owner.finishStartup(1234, 3000, null, '/tmp');

    expect(result).toEqual({
      success: false,
      error: 'Run script was stopped before it could start',
    });
    expect(runScriptStateMachine.markRunning).not.toHaveBeenCalled();
  });

  it('does not persist startup after stop is requested', async () => {
    const { owner } = execution();
    owner.attachProcess(childProcess());
    owner.requestStop();

    const result = await owner.finishStartup(1234, 3000, null, '/tmp');

    expect(result.success).toBe(false);
    expect(runScriptStateMachine.markRunning).not.toHaveBeenCalled();
  });

  it.each([
    { killed: true, exitCode: null, signalCode: null, forceKill: true },
    { killed: false, exitCode: 0, signalCode: null, forceKill: false },
    { killed: false, exitCode: null, signalCode: 'SIGTERM' as const, forceKill: false },
  ])('uses termination evidence for synchronous main cleanup: %j', (params) => {
    const { owner } = execution();
    const child = childProcess(params);
    owner.attachProcess(child);

    owner.cleanupSync();

    if (params.forceKill) {
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } else {
      expect(child.kill).not.toHaveBeenCalled();
    }
  });

  it('does not force kill a main child whose exit was already observed', async () => {
    const { owner } = execution();
    const child = childProcess();
    owner.attachProcess(child);
    await owner.observeExit(0, null);

    owner.cleanupSync();

    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([
    { killed: true, exitCode: null, signalCode: null, forceKill: true },
    { killed: false, exitCode: 0, signalCode: null, forceKill: false },
    { killed: false, exitCode: null, signalCode: 'SIGTERM' as const, forceKill: false },
  ])('uses termination evidence for synchronous postRun cleanup: %j', async (params) => {
    const { owner } = execution();
    owner.attachProcess(childProcess());
    const postRun = childProcess(params);
    vi.mocked(spawnPipedShellCommand).mockReturnValueOnce(postRun);
    await owner.startPostRun('echo ready', '/tmp', undefined);

    owner.cleanupSync();

    if (params.forceKill) {
      expect(postRun.kill).toHaveBeenCalledWith('SIGKILL');
    } else {
      expect(postRun.kill).not.toHaveBeenCalled();
    }
  });

  it('does not force kill a postRun child whose exit was already observed', async () => {
    const { owner } = execution();
    owner.attachProcess(childProcess());
    const postRun = childProcess();
    vi.mocked(spawnPipedShellCommand).mockReturnValueOnce(postRun);
    await owner.startPostRun('echo ready', '/tmp', undefined);
    postRun.emit('exit', 0, null);

    owner.cleanupSync();

    expect(postRun.kill).not.toHaveBeenCalled();
  });
});
