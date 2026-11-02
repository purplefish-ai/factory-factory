import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import * as ownedProcessGroup from '@/backend/lib/owned-process-group';
const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));
import { executeEventStartupScript } from './event-startup-script';
function setup() {
  const child = Object.assign(new EventEmitter(), {
    pid: 4321,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  spawn.mockReturnValue(child);
  const controller = new AbortController();
  const ports = {
    signal: controller.signal,
    physicalStage: vi.fn(),
    assertCurrent: vi.fn(async () => undefined),
    appendOutput: vi.fn(async () => undefined),
    setPid: vi.fn(async () => undefined),
    clearPid: vi.fn(async () => undefined),
  };
  return { child, controller, ports };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it.skipIf(process.platform === 'win32')(
  'aborts the owned setup group and drains output before returning confirmed cleanup',
  async () => {
    const h = setup();
    let exists = true;
    const signals = vi.spyOn(process, 'kill').mockImplementation((_id, signal) => {
      if (!exists) {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
      if (signal === 'SIGTERM') {
        exists = false;
        h.child.emit('close', null, 'SIGTERM');
      }
      return true;
    });
    const task = executeEventStartupScript({
      cwd: '/test',
      args: ['-c', 'task'],
      timeoutMs: 1000,
      ...h.ports,
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(h.ports.setPid).toHaveBeenCalledWith(4321));
    h.child.stdout.write('setup output');
    h.controller.abort();
    expect(await task).toMatchObject({ kind: 'ABORTED', cleanup: 'CONFIRMED' });
    expect(signals).toHaveBeenCalledWith(-4321, 'SIGTERM');
    expect(h.ports.clearPid).toHaveBeenCalledWith(4321);
    expect(spawn).toHaveBeenCalledWith(
      'bash',
      ['-c', 'task'],
      expect.objectContaining({ detached: true })
    );
  }
);
it('returns UNKNOWN on timeout when cleanup cannot prove process disappearance', async () => {
  vi.useFakeTimers();
  const h = setup();
  const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
  const task = executeEventStartupScript({
    cwd: '/test',
    args: ['-c', 'task'],
    timeoutMs: 100,
    ...h.ports,
  }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(6000);
  expect(await task).toMatchObject({ kind: 'TIMED_OUT', cleanup: 'UNKNOWN' });
  expect(h.ports.clearPid).not.toHaveBeenCalled();
  expect(h.ports.physicalStage).toHaveBeenLastCalledWith(false);
  if (process.platform !== 'win32') {
    expect(signal).toHaveBeenCalledWith(-4321, 'SIGKILL');
  }
});
it('retains the original PID while cleanup is pending and after UNKNOWN without a null write', async () => {
  const h = setup();
  let storedPid: number | null = null;
  const history: Array<number | null> = [];
  let release!: () => void;
  const cleanup = new Promise<'UNKNOWN'>((resolve) => {
    release = () => resolve('UNKNOWN');
  });
  const stop = vi.spyOn(ownedProcessGroup, 'stopOwnedProcessGroup').mockReturnValue(cleanup);
  const signals = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw new Error('No host signals');
  });
  h.ports.setPid.mockImplementation(() => {
    storedPid = h.child.pid;
    history.push(storedPid);
    return Promise.resolve(undefined);
  });
  h.ports.clearPid.mockImplementation(() => {
    storedPid = null;
    history.push(storedPid);
    return Promise.resolve(undefined);
  });
  let settled = false;
  const task = executeEventStartupScript({
    cwd: '/test',
    args: ['-c', 'task'],
    timeoutMs: 10_000,
    ...h.ports,
  })
    .catch((error: unknown) => error)
    .then((result) => {
      settled = true;
      return result;
    });
  try {
    await vi.waitFor(() => expect(storedPid).toBe(4321));
    h.controller.abort();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(storedPid).toBe(4321);
    expect(history).toEqual([4321]);
    release();
    expect(await task).toMatchObject({ cleanup: 'UNKNOWN' });
    expect(storedPid).toBe(4321);
    expect(history).toEqual([4321]);
    expect(h.ports.clearPid).not.toHaveBeenCalled();
    expect(signals).not.toHaveBeenCalled();
  } finally {
    h.controller.abort();
    release();
    await task;
  }
});

it('does not spawn when the current claim check fails', async () => {
  const h = setup();
  spawn.mockClear();
  h.ports.assertCurrent.mockRejectedValue(new Error('stale claim'));
  await expect(
    executeEventStartupScript({ cwd: '/test', args: ['-c', 'task'], timeoutMs: 100, ...h.ports })
  ).rejects.toThrow('stale claim');
  expect(spawn).not.toHaveBeenCalled();
});
it('lets successful background descendants retain pipes without signalling their group', async () => {
  vi.useFakeTimers();
  const h = setup();
  const signals = vi.spyOn(process, 'kill').mockReturnValue(true);
  const task = executeEventStartupScript({
    cwd: '/test',
    args: ['-c', 'task'],
    timeoutMs: 5000,
    ...h.ports,
  });
  await vi.advanceTimersByTimeAsync(0);
  h.child.stdout.write('foreground done');
  h.child.emit('exit', 0, null);
  await vi.advanceTimersByTimeAsync(1001);
  expect(await task).toEqual({ success: true });
  expect(h.ports.appendOutput).toHaveBeenCalledWith('foreground done');
  expect(signals).not.toHaveBeenCalled();
  h.child.stdout.write('late background output');
  await vi.advanceTimersByTimeAsync(0);
  expect(h.ports.appendOutput).toHaveBeenCalledTimes(1);
});
it.skipIf(process.platform === 'win32')(
  'stops and drains the owned script when output persistence fails',
  async () => {
    const h = setup();
    let exists = true;
    vi.spyOn(process, 'kill').mockImplementation((_id, signal) => {
      if (!exists) {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
      if (signal === 'SIGTERM') {
        exists = false;
      }
      return true;
    });
    h.ports.appendOutput.mockRejectedValue(new Error('database write failed'));
    const task = executeEventStartupScript({
      cwd: '/test',
      args: ['-c', 'task'],
      timeoutMs: 1000,
      ...h.ports,
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(h.ports.setPid).toHaveBeenCalledWith(4321));
    h.child.stdout.write('write fails');
    expect(await task).toMatchObject({ kind: 'FAILED', cleanup: 'CONFIRMED' });
    expect(h.ports.clearPid).toHaveBeenCalledWith(4321);
  }
);
it('treats an externally signalled setup exit as failure, not an ordinary nonzero warning', async () => {
  const h = setup();
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  const task = executeEventStartupScript({
    cwd: '/test',
    args: ['-c', 'task'],
    timeoutMs: 1000,
    ...h.ports,
  }).catch((error: unknown) => error);
  await vi.waitFor(() => expect(h.ports.setPid).toHaveBeenCalledWith(4321));
  h.child.emit('exit', null, 'SIGTERM');
  h.child.emit('close', null, 'SIGTERM');
  expect(await task).toMatchObject({ kind: 'FAILED' });
});
it.each(['output', 'pid'] as const)(
  'keeps cancellation owned while %s persistence drains after foreground close',
  async (phase) => {
    const h = setup();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = phase === 'output' ? h.ports.appendOutput : h.ports.setPid;
    write.mockImplementation(() => pending.then(() => undefined));
    const signals = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('unconfirmed'), { code: 'EPERM' });
    });
    let done = false;
    const task = executeEventStartupScript({
      cwd: '/test',
      args: ['-c', 'task'],
      timeoutMs: 10_000,
      ...h.ports,
    })
      .catch((error: unknown) => error)
      .then((result) => {
        done = true;
        return result;
      });
    try {
      await vi.waitFor(() => expect(h.ports.setPid).toHaveBeenCalledWith(4321));
      if (phase === 'output') {
        h.child.stdout.write('pending output');
        await vi.waitFor(() => expect(write).toHaveBeenCalled());
      }
      h.child.emit('exit', 0, null);
      h.child.emit('close', 0, null);
      await vi.waitFor(() => expect(write).toHaveBeenCalled());
      h.controller.abort();
      await nextTurn();
      expect(done).toBe(false);
      expect(h.ports.physicalStage).toHaveBeenLastCalledWith(false);
      release();
      expect(await task).toMatchObject({ kind: 'ABORTED', cleanup: 'UNKNOWN' });
      if (process.platform !== 'win32') {
        expect(signals).toHaveBeenCalledWith(-4321, 0);
      }
      expect(h.child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      release();
      await task;
    }
  }
);
it('keeps the deadline active while output persistence drains after foreground close', async () => {
  vi.useFakeTimers();
  const h = setup();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.ports.appendOutput.mockImplementation(() => pending.then(() => undefined));
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  let done = false;
  const task = executeEventStartupScript({
    cwd: '/test',
    args: ['-c', 'task'],
    timeoutMs: 100,
    ...h.ports,
  })
    .catch((error: unknown) => error)
    .then((result) => {
      done = true;
      return result;
    });
  try {
    await vi.advanceTimersByTimeAsync(0);
    h.child.stdout.write('pending output');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.ports.appendOutput).toHaveBeenCalledWith('pending output');
    h.child.emit('exit', 0, null);
    h.child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(101);
    expect(done).toBe(false);
    release();
    expect(await task).toMatchObject({
      kind: 'TIMED_OUT',
      cleanup: process.platform === 'win32' ? 'UNKNOWN' : 'CONFIRMED',
    });
  } finally {
    release();
    await task;
  }
});
