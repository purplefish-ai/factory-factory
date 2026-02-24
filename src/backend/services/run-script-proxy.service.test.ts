import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configService } from './config.service';

const mockStartCloudflaredTunnel = vi.hoisted(() => vi.fn());
const mockKillProcessWithTimeout = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@/shared/proxy-utils', () => ({
  authenticateRequest: vi.fn(() => ({
    authenticated: false,
    invalidToken: false,
    viaToken: false,
    sanitizedPath: '/',
  })),
  createAuthCookie: vi.fn(() => 'cookie=1'),
  createSessionValue: vi.fn(() => ({ id: 's', signature: 'sig' })),
  proxyAuthenticatedHttpRequest: vi.fn(),
  proxyAuthenticatedWebSocketUpgrade: vi.fn(),
  startCloudflaredTunnel: mockStartCloudflaredTunnel,
  killProcessWithTimeout: mockKillProcessWithTimeout,
}));

vi.mock('./logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { RunScriptProxyService } from './run-script-proxy.service';

type ProxyServiceInternals = {
  cleanupSync: () => void;
  tunnels: Map<
    string,
    {
      upstreamPort: number;
      publicUrl: string;
      authenticatedUrl: string;
      cloudflaredProcess: ChildProcess;
      closeAuthProxy: () => Promise<void>;
    }
  >;
  cloudflaredUnavailable: boolean;
};

function createChildProcess(pid = 1234): ChildProcess {
  return {
    pid,
    exitCode: null,
    kill: vi.fn(),
  } as unknown as ChildProcess;
}

describe('RunScriptProxyService', () => {
  const originalProxyEnv = process.env.FF_RUN_SCRIPT_PROXY_ENABLED;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FF_RUN_SCRIPT_PROXY_ENABLED = '1';
    configService.reload();
    mockStartCloudflaredTunnel.mockResolvedValue({
      publicUrl: 'https://abc.trycloudflare.com',
      proc: createChildProcess(),
    });
  });

  afterEach(() => {
    process.env.FF_RUN_SCRIPT_PROXY_ENABLED = originalProxyEnv;
    configService.reload();
  });

  it('returns null when proxy feature is disabled', async () => {
    process.env.FF_RUN_SCRIPT_PROXY_ENABLED = '0';
    configService.reload();
    const service = new RunScriptProxyService();

    await expect(service.ensureTunnel('w1', 3000)).resolves.toBeNull();
    expect(mockStartCloudflaredTunnel).not.toHaveBeenCalled();
  });

  it('creates and reuses authenticated tunnels per workspace/port', async () => {
    const service = new RunScriptProxyService();

    const url = await service.ensureTunnel('w1', 3000);
    expect(url).toMatch(/^https:\/\/abc\.trycloudflare\.com\?token=/);
    expect(service.getTunnelUrl('w1')).toBe(url);

    const reused = await service.ensureTunnel('w1', 3000);
    expect(reused).toBe(url);
    expect(mockStartCloudflaredTunnel).toHaveBeenCalledTimes(1);

    await service.stopTunnel('w1');
    expect(mockKillProcessWithTimeout).toHaveBeenCalledTimes(1);
    expect(service.getTunnelUrl('w1')).toBeNull();
  });

  it('replaces existing tunnel when upstream port changes', async () => {
    const service = new RunScriptProxyService();
    const first = await service.ensureTunnel('w1', 3000);
    expect(first).toBeTruthy();

    const second = await service.ensureTunnel('w1', 4173);
    expect(second).toMatch(/^https:\/\/abc\.trycloudflare\.com\?token=/);
    expect(mockKillProcessWithTimeout).toHaveBeenCalledTimes(1);
    expect(mockStartCloudflaredTunnel).toHaveBeenCalledTimes(2);
  });

  it('marks cloudflared unavailable on command-not-found errors', async () => {
    const service = new RunScriptProxyService() as unknown as ProxyServiceInternals;
    mockStartCloudflaredTunnel.mockRejectedValueOnce(new Error('ENOENT: command not found'));

    await expect(
      (service as unknown as RunScriptProxyService).ensureTunnel('w1', 3000)
    ).resolves.toBeNull();
    expect(service.cloudflaredUnavailable).toBe(true);

    mockStartCloudflaredTunnel.mockClear();
    await expect(
      (service as unknown as RunScriptProxyService).ensureTunnel('w2', 3001)
    ).resolves.toBeNull();
    expect(mockStartCloudflaredTunnel).not.toHaveBeenCalled();
  });

  it('cleanup stops all active tunnels', async () => {
    const service = new RunScriptProxyService();
    await service.ensureTunnel('w1', 3000);
    await service.ensureTunnel('w2', 3001);

    await service.cleanup();

    expect(mockKillProcessWithTimeout).toHaveBeenCalledTimes(2);
    expect(service.getTunnelUrl('w1')).toBeNull();
    expect(service.getTunnelUrl('w2')).toBeNull();
  });

  it('cleanupSync kills active cloudflared processes and clears tunnel map', () => {
    const service = new RunScriptProxyService() as unknown as ProxyServiceInternals;
    const cloudflaredKill = vi.fn();
    const closeAuthProxy = vi.fn().mockResolvedValue(undefined);

    service.tunnels.set('ws-1', {
      upstreamPort: 5173,
      publicUrl: 'https://example.trycloudflare.com',
      authenticatedUrl: 'https://example.trycloudflare.com?token=abc123',
      cloudflaredProcess: {
        pid: 12_345,
        exitCode: null,
        kill: cloudflaredKill,
      } as unknown as ChildProcess,
      closeAuthProxy,
    });

    service.cleanupSync();

    expect(cloudflaredKill).toHaveBeenCalledWith('SIGKILL');
    expect(closeAuthProxy).toHaveBeenCalledTimes(1);
    expect(service.tunnels.size).toBe(0);
  });

  it('cleanupSync does not kill already-exited processes', () => {
    const service = new RunScriptProxyService() as unknown as ProxyServiceInternals;
    const cloudflaredKill = vi.fn();
    const closeAuthProxy = vi.fn().mockResolvedValue(undefined);

    service.tunnels.set('ws-1', {
      upstreamPort: 5173,
      publicUrl: 'https://example.trycloudflare.com',
      authenticatedUrl: 'https://example.trycloudflare.com?token=abc123',
      cloudflaredProcess: {
        pid: 12_345,
        exitCode: 0,
        kill: cloudflaredKill,
      } as unknown as ChildProcess,
      closeAuthProxy,
    });

    service.cleanupSync();

    expect(cloudflaredKill).not.toHaveBeenCalled();
    expect(closeAuthProxy).toHaveBeenCalledTimes(1);
    expect(service.tunnels.size).toBe(0);
  });
});
