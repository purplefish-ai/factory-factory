import { describe, expect, it, vi } from 'vitest';
import { RunScriptProxyService } from './run-script-proxy.service';

vi.mock('./logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

type ProxyServiceInternals = {
  cleanupSync: () => void;
  tunnels: Map<
    string,
    {
      upstreamPort: number;
      publicUrl: string;
      authenticatedUrl: string;
      cloudflaredProcess: {
        pid?: number;
        exitCode: number | null;
        kill: (signal: NodeJS.Signals) => void;
      };
      closeAuthProxy: () => Promise<void>;
    }
  >;
};

describe('RunScriptProxyService.cleanupSync', () => {
  it('kills active cloudflared processes and clears tunnel map', () => {
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
      },
      closeAuthProxy,
    });

    service.cleanupSync();

    expect(cloudflaredKill).toHaveBeenCalledWith('SIGKILL');
    expect(closeAuthProxy).toHaveBeenCalledTimes(1);
    expect(service.tunnels.size).toBe(0);
  });

  it('does not kill cloudflared when process already exited', () => {
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
      },
      closeAuthProxy,
    });

    service.cleanupSync();

    expect(cloudflaredKill).not.toHaveBeenCalled();
    expect(closeAuthProxy).toHaveBeenCalledTimes(1);
    expect(service.tunnels.size).toBe(0);
  });
});
