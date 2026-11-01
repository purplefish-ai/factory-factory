import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
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
  if (process.platform !== 'win32') {
    expect(signal).toHaveBeenCalledWith(-4321, 'SIGKILL');
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
    timeoutMs: 1000,
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
