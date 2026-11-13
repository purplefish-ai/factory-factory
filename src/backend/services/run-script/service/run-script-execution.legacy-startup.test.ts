import './run-script-legacy.test-support';
import { describe, expect, it, vi } from 'vitest';
import { FactoryConfigService } from './factory-config.service';
import {
  FakeChildProcess,
  createExecutionOwner,
  mockEnsureTunnel,
  mockFindById,
  mockMarkRunning,
  mockSpawn,
  mockStopTunnel,
} from './run-script-legacy.test-support';

describe('RunScriptExecution.finishStartup', () => {
  it('cleans up proxy tunnel when process exits during tunnel startup', async () => {
    let resolveTunnel!: (value: string | null) => void;
    mockEnsureTunnel.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolveTunnel = resolve;
        })
    );
    const owner = createExecutionOwner(new FakeChildProcess(12_345));
    const startup = owner.execution.finishStartup(12_345, 5173, null, '/tmp/ws-1');
    await Promise.resolve();
    owner.discard();
    resolveTunnel('https://example.trycloudflare.com?token=abc123');
    const result = await startup;
    expect(mockMarkRunning).toHaveBeenCalledWith('ws-1', { pid: 12_345, port: 5173 });
    expect(mockEnsureTunnel).toHaveBeenCalledWith('ws-1', 5173);
    expect(mockStopTunnel).toHaveBeenCalledWith('ws-1');
    expect(result).toMatchObject({ success: true, port: 5173, pid: 12_345 });
    expect(result.proxyUrl).toBeUndefined();
  });

  it('starts postRun using reconciled command arguments', async () => {
    const owner = createExecutionOwner(new FakeChildProcess(12_345));
    const postRun = vi.spyOn(owner.execution, 'startPostRun').mockResolvedValue(undefined);
    const result = await owner.execution.finishStartup(
      12_345,
      undefined,
      'echo post-run',
      '/tmp/ws-1'
    );
    expect(result).toMatchObject({ success: true, pid: 12_345 });
    expect(postRun).toHaveBeenCalledWith('echo post-run', '/tmp/ws-1', undefined);
  });

  it('keeps transition successful when postRun setup throws synchronously', async () => {
    vi.spyOn(FactoryConfigService, 'substitutePort').mockImplementation(() => {
      throw new Error('bad postRun command');
    });
    const owner = createExecutionOwner(new FakeChildProcess(12_345));
    const result = await owner.execution.finishStartup(12_345, 5173, 'echo {port}', '/tmp/ws-1');
    expect(result).toMatchObject({ success: true, port: 5173, pid: 12_345 });
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('returns tunnel URL when process is still active after tunnel starts', async () => {
    mockEnsureTunnel.mockResolvedValue('https://example.trycloudflare.com');
    const owner = createExecutionOwner(new FakeChildProcess(12_345));
    await expect(
      owner.execution.finishStartup(12_345, 5173, null, '/tmp/ws-1')
    ).resolves.toMatchObject({ proxyUrl: 'https://example.trycloudflare.com' });
    expect(mockStopTunnel).not.toHaveBeenCalled();
  });

  it('handles markRunning races for completed/failed states', async () => {
    mockMarkRunning.mockRejectedValue(new Error('CAS failed'));
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'COMPLETED' });
    const owner = createExecutionOwner(new FakeChildProcess(12_345));
    await expect(owner.execution.finishStartup(12_345, 5173, null, '/tmp/ws-1')).resolves.toEqual({
      success: true,
      port: 5173,
      pid: 12_345,
    });
  });

  it('kills orphaned process when stop wins markRunning race', async () => {
    mockMarkRunning.mockRejectedValue(new Error('CAS failed'));
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'IDLE' });
    const child = new FakeChildProcess(12_345);
    child.kill.mockImplementation(() => {
      throw new Error('already exited');
    });
    const owner = createExecutionOwner(child);
    await expect(
      owner.execution.finishStartup(12_345, undefined, null, '/tmp/ws-1')
    ).resolves.toEqual({ success: false, error: 'Run script was stopped before it could start' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(owner.current()).toBeUndefined();
  });

  it('rethrows markRunning race errors for unexpected states', async () => {
    const error = new Error('unexpected');
    mockMarkRunning.mockRejectedValue(error);
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'RUNNING' });
    const owner = createExecutionOwner(new FakeChildProcess(12_345));
    await expect(
      owner.execution.finishStartup(12_345, undefined, null, '/tmp/ws-1')
    ).rejects.toThrow(error);
  });
});
