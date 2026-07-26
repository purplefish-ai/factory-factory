import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.hoisted(() => vi.fn());
const mockClearInitOutput = vi.hoisted(() => vi.fn());
const mockAppendInitOutput = vi.hoisted(() => vi.fn());
const mockSetInitScriptPid = vi.hoisted(() => vi.fn());
const mockClearInitScriptPid = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock('@/backend/services/workspace', () => ({
  workspaceRunScriptService: {
    clearInitOutput: (...args: unknown[]) => mockClearInitOutput(...args),
    appendInitOutput: (...args: unknown[]) => mockAppendInitOutput(...args),
    setInitScriptPid: (...args: unknown[]) => mockSetInitScriptPid(...args),
    clearInitScriptPid: (...args: unknown[]) => mockClearInitScriptPid(...args),
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { startupScriptService } from './startup-script.service';

class FakeProc extends EventEmitter {
  pid = 12_345;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

describe('StartupScriptService', () => {
  const markReady = vi.fn();
  const markFailed = vi.fn();
  const service = startupScriptService;

  beforeEach(() => {
    vi.clearAllMocks();
    service.configure({
      workspace: {
        markReady,
        markFailed,
        clearInitOutput: mockClearInitOutput,
        appendInitOutput: mockAppendInitOutput,
        setInitScriptPid: mockSetInitScriptPid,
        clearInitScriptPid: mockClearInitScriptPid,
      },
    });
    mockClearInitOutput.mockResolvedValue(undefined);
    mockAppendInitOutput.mockResolvedValue(undefined);
    mockSetInitScriptPid.mockResolvedValue(undefined);
    mockClearInitScriptPid.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks workspace ready immediately when no startup script is configured', async () => {
    const result = await service.runStartupScript(
      { id: 'w1', worktreePath: '/tmp/w1' } as never,
      {
        startupScriptCommand: null,
        startupScriptPath: null,
      } as never
    );

    expect(result).toEqual({
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      durationMs: 0,
    });
    expect(markReady).toHaveBeenCalledWith('w1');
    expect(mockClearInitOutput).not.toHaveBeenCalled();
  });

  it('throws when workspace has no worktree path', async () => {
    await expect(
      service.runStartupScript(
        { id: 'w1', worktreePath: null } as never,
        {
          startupScriptCommand: 'echo test',
          startupScriptPath: null,
        } as never
      )
    ).rejects.toThrow('Workspace has no worktree path');
  });

  it('fails with markFailed for invalid startup script path', async () => {
    const result = await service.runStartupScript(
      { id: 'w1', worktreePath: '/tmp/w1' } as never,
      {
        startupScriptCommand: null,
        startupScriptPath: '../escape.sh',
        startupScriptTimeout: 5,
      } as never
    );

    expect(result.success).toBe(false);
    expect(result.stderr).toContain('Script path must be relative');
    expect(mockClearInitOutput).toHaveBeenCalledWith('w1');
    expect(markFailed).toHaveBeenCalledWith('w1', expect.stringContaining('Script path must'));
  });

  it('runs startup command and marks workspace ready on success', async () => {
    mockSpawn.mockImplementation(() => {
      const proc = new FakeProc();
      queueMicrotask(() => {
        proc.stdout.emit('data', Buffer.from('hello'));
        proc.stderr.emit('data', Buffer.from('warn'));
        proc.emit('close', 0);
      });
      return proc;
    });

    const result = await service.runStartupScript(
      { id: 'w1', worktreePath: '/tmp/w1' } as never,
      {
        startupScriptCommand: 'echo hello',
        startupScriptPath: null,
        startupScriptTimeout: 5,
      } as never
    );

    expect(result).toMatchObject({
      success: true,
      exitCode: 0,
      timedOut: false,
    });
    expect(result.stdout).toContain('hello');
    expect(result.stderr).toContain('warn');
    expect(markReady).toHaveBeenCalledWith('w1');
    expect(mockAppendInitOutput).toHaveBeenCalledWith('w1', expect.stringContaining('hello'));
    expect(mockSetInitScriptPid).toHaveBeenCalledWith('w1', 12_345);
    expect(mockClearInitScriptPid).toHaveBeenCalledWith('w1', 12_345);
  });

  it('reports a natural exit at the timeout boundary as successful', async () => {
    vi.useFakeTimers();
    const proc = new FakeProc();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = service.runStartupScript(
      { id: 'w1', worktreePath: '/tmp/w1' } as never,
      {
        startupScriptCommand: 'pnpm test',
        startupScriptPath: null,
        startupScriptTimeout: 1,
      } as never
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    proc.emit('close', 0, null);

    await expect(resultPromise).resolves.toMatchObject({
      success: true,
      exitCode: 0,
      timedOut: false,
    });
    expect(markReady).toHaveBeenCalledWith('w1');
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('reports a process terminated by the timeout signal as timed out', async () => {
    vi.useFakeTimers();
    const proc = new FakeProc();
    proc.kill.mockReturnValue(true);
    mockSpawn.mockReturnValue(proc);

    const resultPromise = service.runStartupScript(
      { id: 'w1', worktreePath: '/tmp/w1' } as never,
      {
        startupScriptCommand: 'pnpm test',
        startupScriptPath: null,
        startupScriptTimeout: 1,
      } as never
    );

    await vi.advanceTimersByTimeAsync(1000);
    proc.emit('close', null, 'SIGTERM');

    await expect(resultPromise).resolves.toMatchObject({
      success: false,
      exitCode: null,
      timedOut: true,
    });
    expect(markFailed).toHaveBeenCalledWith('w1', 'Script timed out after 1 seconds');
  });

  it('does not escalate after the process exits during the SIGTERM grace period', async () => {
    vi.useFakeTimers();
    const proc = new FakeProc();
    proc.kill.mockReturnValue(true);
    mockSpawn.mockReturnValue(proc);

    const resultPromise = service.runStartupScript(
      { id: 'w1', worktreePath: '/tmp/w1' } as never,
      {
        startupScriptCommand: 'pnpm test',
        startupScriptPath: null,
        startupScriptTimeout: 1,
      } as never
    );

    await vi.advanceTimersByTimeAsync(1000);
    proc.emit('exit', null, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(5000);

    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    proc.emit('close', null, 'SIGTERM');
    await resultPromise;
  });

  it('does not schedule SIGKILL escalation when SIGTERM was not sent', async () => {
    vi.useFakeTimers();
    const proc = new FakeProc();
    proc.kill.mockReturnValue(false);
    mockSpawn.mockReturnValue(proc);

    const resultPromise = service.runStartupScript(
      { id: 'w1', worktreePath: '/tmp/w1' } as never,
      {
        startupScriptCommand: 'pnpm test',
        startupScriptPath: null,
        startupScriptTimeout: 1,
      } as never
    );

    await vi.advanceTimersByTimeAsync(6000);

    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    proc.emit('close', 0, null);
    await resultPromise;
  });

  it('does not report a different termination signal as the startup-script timeout', async () => {
    vi.useFakeTimers();
    const proc = new FakeProc();
    proc.kill.mockReturnValue(true);
    mockSpawn.mockReturnValue(proc);

    const resultPromise = service.runStartupScript(
      { id: 'w1', worktreePath: '/tmp/w1' } as never,
      {
        startupScriptCommand: 'pnpm test',
        startupScriptPath: null,
        startupScriptTimeout: 1,
      } as never
    );

    await vi.advanceTimersByTimeAsync(1000);
    proc.emit('close', null, 'SIGINT');

    await expect(resultPromise).resolves.toMatchObject({
      success: false,
      exitCode: null,
      timedOut: false,
    });
  });

  it('marks workspace failed when spawn emits error', async () => {
    mockSpawn.mockImplementation(() => {
      const proc = new FakeProc();
      queueMicrotask(() => {
        proc.emit('error', new Error('spawn failed'));
      });
      return proc;
    });

    const result = await service.runStartupScript(
      { id: 'w1', worktreePath: '/tmp/w1' } as never,
      {
        startupScriptCommand: 'echo hello',
        startupScriptPath: null,
        startupScriptTimeout: 5,
      } as never
    );

    expect(result.success).toBe(false);
    expect(result.stderr).toContain('spawn failed');
    expect(markFailed).toHaveBeenCalledWith('w1', expect.stringContaining('spawn failed'));
  });

  it('validates script paths and script readability', async () => {
    expect(service.validateScriptPath('scripts/start.sh', '/repo')).toEqual({ valid: true });
    expect(service.validateScriptPath('../start.sh', '/repo')).toEqual({
      valid: false,
      error: 'Script path must be relative to repository root',
    });
    expect(service.validateScriptPath('/tmp/start.sh', '/repo')).toEqual({
      valid: false,
      error: 'Script path must be relative to repository root',
    });

    const rootDir = mkdtempSync(join(tmpdir(), 'startup-script-'));
    const scriptPath = join(rootDir, 'start.sh');
    writeFileSync(scriptPath, 'echo hi\n');

    await expect(service.validateScriptReadable('start.sh', rootDir)).resolves.toEqual({
      readable: true,
    });

    await expect(service.validateScriptReadable('missing.sh', rootDir)).resolves.toEqual({
      readable: false,
      error: 'Script not found: missing.sh',
    });

    await rm(rootDir, { recursive: true, force: true });
  });

  it('reports whether startup script is configured', () => {
    expect(service.hasStartupScript({ startupScriptCommand: 'echo hi' } as never)).toBe(true);
    expect(service.hasStartupScript({ startupScriptPath: 'scripts/start.sh' } as never)).toBe(true);
    expect(
      service.hasStartupScript({ startupScriptCommand: null, startupScriptPath: null } as never)
    ).toBe(false);
  });

  it('swallows append-init-output errors in debounced callback flush', async () => {
    mockAppendInitOutput.mockRejectedValue(new Error('db down'));

    const internals = service as unknown as {
      createDebouncedOutputCallback: (workspaceId: string) => {
        callback: (output: string) => void;
        flush: () => Promise<void>;
      };
    };

    const { callback, flush } = internals.createDebouncedOutputCallback('w1');
    callback('x'.repeat(4100));
    await flush();

    expect(mockAppendInitOutput).toHaveBeenCalled();
  });
});
