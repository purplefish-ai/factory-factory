import { describe, expect, it } from 'vitest';
import { decideTunnelOrigin, toTunnelOrigin } from './proxy-tunnel-origin';

const TUNNEL = 'https://quiet-river.trycloudflare.com';
const BACKEND = 'http://localhost:3001';

function decide(overrides: Partial<Parameters<typeof decideTunnelOrigin>[0]>) {
  return decideTunnelOrigin({
    method: 'POST',
    origin: TUNNEL,
    isUpgrade: false,
    tunnelOrigin: TUNNEL,
    backendOrigin: BACKEND,
    ...overrides,
  });
}

describe('decideTunnelOrigin', () => {
  it('rewrites the tunnel origin to the backend origin', () => {
    expect(decide({})).toEqual({ allowed: true, upstreamOrigin: BACKEND });
    expect(decide({ method: 'GET', isUpgrade: true })).toEqual({
      allowed: true,
      upstreamOrigin: BACKEND,
    });
  });

  it.each([
    'https://other.trycloudflare.com',
    `${TUNNEL}:443`,
    `${TUNNEL}/`,
    'HTTPS://QUIET-RIVER.TRYCLOUDFLARE.COM',
    BACKEND,
    'null',
    '',
    `${TUNNEL}, https://evil.example`,
  ])('refuses Origin %j', (origin) => {
    expect(decide({ origin })).toMatchObject({ allowed: false, status: 403 });
  });

  it('requires an Origin for state changes and upgrades only', () => {
    expect(decide({ origin: undefined })).toMatchObject({ allowed: false, status: 403 });
    expect(decide({ origin: undefined, method: 'GET', isUpgrade: true })).toMatchObject({
      allowed: false,
      status: 403,
    });
    for (const method of ['GET', 'HEAD']) {
      expect(decide({ origin: undefined, method })).toEqual({
        allowed: true,
        upstreamOrigin: undefined,
      });
    }
  });

  it('refuses any Origin until the tunnel URL is known', () => {
    expect(decide({ tunnelOrigin: null })).toMatchObject({ allowed: false, status: 503 });
    expect(decide({ tunnelOrigin: null, method: 'GET' })).toMatchObject({ allowed: false });
  });
});

describe('toTunnelOrigin', () => {
  it('takes the origin of the https URL cloudflared prints', () => {
    expect(toTunnelOrigin('https://quiet-river.trycloudflare.com')).toBe(TUNNEL);
    expect(() => toTunnelOrigin('http://quiet-river.trycloudflare.com')).toThrow();
  });
});
