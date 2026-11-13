import './run-script-legacy.test-support';
import { describe, expect, it } from 'vitest';
import {
  FakeChildProcess,
  createExecutionOwner,
  mockSpawn,
  mockTreeKill,
  spawnOwnedPostRun,
} from './run-script-legacy.test-support';

const activeOwner = () => createExecutionOwner(new FakeChildProcess(12_345));

describe('RunScriptExecution postRun ownership', () => {
  it('does nothing when no postRun process exists', async () => {
    await activeOwner().execution.killPostRunProcess();
    expect(mockTreeKill).not.toHaveBeenCalled();
  });

  it('does not retain a postRun process without pid for later killing', async () => {
    const owner = activeOwner();
    await spawnOwnedPostRun(owner.execution, new FakeChildProcess(undefined));
    await owner.execution.killPostRunProcess();
    expect(mockTreeKill).not.toHaveBeenCalled();
  });

  it('tree-kills postRun process by pid', async () => {
    const owner = activeOwner();
    await spawnOwnedPostRun(owner.execution, new FakeChildProcess(888));
    await owner.execution.killPostRunProcess();
    expect(mockTreeKill).toHaveBeenCalledWith(888, 'SIGTERM', expect.any(Function));
    await owner.execution.killPostRunProcess();
    expect(mockTreeKill).toHaveBeenCalledTimes(1);
  });

  it('handles ESRCH error gracefully when postRun process already exited', async () => {
    const error = Object.assign(new Error('No such process'), { code: 'ESRCH' });
    mockTreeKill.mockImplementation((_pid, _signal, callback) => callback(error));
    const owner = activeOwner();
    await spawnOwnedPostRun(owner.execution, new FakeChildProcess(888));
    await owner.execution.killPostRunProcess();
    await owner.execution.killPostRunProcess();
    expect(mockTreeKill).toHaveBeenCalledTimes(1);
  });

  it('does not delete a newer postRun process after the previous kill completes', async () => {
    let complete!: (error: Error | null) => void;
    mockTreeKill.mockImplementation((_pid, _signal, callback) => {
      complete = callback;
    });
    const owner = activeOwner();
    await spawnOwnedPostRun(owner.execution, new FakeChildProcess(888));
    const kill = owner.execution.killPostRunProcess();
    await spawnOwnedPostRun(owner.execution, new FakeChildProcess(999));
    complete(null);
    await kill;
    mockTreeKill.mockImplementation((_pid, _signal, callback) => callback(null));
    await owner.execution.killPostRunProcess();
    expect(mockTreeKill).toHaveBeenNthCalledWith(2, 999, 'SIGTERM', expect.any(Function));
  });

  it('spawns postRun process, captures output, and releases it on exit', async () => {
    const child = new FakeChildProcess(88_888);
    mockSpawn.mockReturnValue(child);
    const owner = activeOwner();
    await owner.execution.startPostRun('echo postrun {port}', '/tmp/ws-1', 3000);
    expect(mockSpawn).toHaveBeenCalledWith('bash', ['-c', 'echo postrun 3000'], {
      cwd: '/tmp/ws-1',
      env: expect.any(Object),
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.emit('data', Buffer.from('post stdout'));
    child.stderr.emit('data', Buffer.from('post stderr'));
    child.stdout.emit('error', new Error('stdout fail'));
    child.stderr.emit('error', new Error('stderr fail'));
    expect(owner.postRunOutput).toHaveBeenCalledWith('post stdout');
    expect(owner.postRunOutput).toHaveBeenCalledWith('post stderr');
    child.emit('exit', 0, null);
    await owner.execution.killPostRunProcess();
    expect(mockTreeKill).not.toHaveBeenCalled();
  });

  it('releases postRun process on spawn error', async () => {
    const owner = activeOwner();
    const child = new FakeChildProcess(88_888);
    await spawnOwnedPostRun(owner.execution, child);
    child.emit('error', new Error('spawn failed'));
    await owner.execution.killPostRunProcess();
    expect(mockTreeKill).not.toHaveBeenCalled();
  });

  it('keeps a replacement postRun process when the previous process exits or errors', async () => {
    const owner = activeOwner();
    const previous = new FakeChildProcess(88_888);
    await spawnOwnedPostRun(owner.execution, previous);
    await spawnOwnedPostRun(owner.execution, new FakeChildProcess(99_999));
    previous.emit('exit', 0, null);
    previous.emit('error', new Error('late spawn error'));
    await owner.execution.killPostRunProcess();
    expect(mockTreeKill).toHaveBeenCalledWith(99_999, 'SIGTERM', expect.any(Function));
    expect(mockTreeKill).toHaveBeenCalledTimes(1);
  });

  it('returns early when postRun process cannot provide a pid', async () => {
    const owner = activeOwner();
    await spawnOwnedPostRun(owner.execution, new FakeChildProcess(undefined));
    expect(owner.output).not.toHaveBeenCalled();
    expect(owner.postRunOutput).not.toHaveBeenCalled();
  });

  it('warns and still releases ownership when tree-kill postRun fails unexpectedly', async () => {
    const error = Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
    mockTreeKill.mockImplementation((_pid, _signal, callback) => callback(error));
    const owner = activeOwner();
    await spawnOwnedPostRun(owner.execution, new FakeChildProcess(88_888));
    await owner.execution.killPostRunProcess();
    await owner.execution.killPostRunProcess();
    expect(mockTreeKill).toHaveBeenCalledTimes(1);
  });
});
