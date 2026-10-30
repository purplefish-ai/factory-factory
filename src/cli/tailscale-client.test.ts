import { describe, expect, it } from 'vitest';
import { assertServePortAvailable, getTailscaleOrigin, parsePort } from './tailscale-client';

describe('Tailscale discovery', () => {
  it('uses the machine DNS name and removes its trailing dot', () => {
    expect(
      getTailscaleOrigin(
        JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'my-mac.tail123.ts.net.' } }),
        443
      )
    ).toBe('https://my-mac.tail123.ts.net');
  });
  it('includes a non-default HTTPS port', () => {
    expect(
      getTailscaleOrigin(
        JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'my-mac.tail123.ts.net.' } }),
        8443
      )
    ).toBe('https://my-mac.tail123.ts.net:8443');
  });
  it.each(['NeedsLogin', 'Stopped', 'NeedsMachineAuth'])('rejects %s nodes', (BackendState) => {
    expect(() =>
      getTailscaleOrigin(JSON.stringify({ BackendState, Self: { DNSName: 'mac.ts.net.' } }), 443)
    ).toThrow(/connect|login|running/i);
  });
  it.each([
    'null',
    '{}',
    'invalid',
    '{"BackendState":"Running","Self":null}',
    '{"BackendState":"Running","Self":{"DNSName":""}}',
    '{"BackendState":"Running","Self":{"DNSName":"evil.com/path"}}',
  ])('rejects unusable status %s', (status) => {
    expect(() => getTailscaleOrigin(status, 443)).toThrow();
  });
});

describe('Serve conflict protection', () => {
  it.each(['null', '{}', '{"TCP":{"8443":{"HTTPS":true}}}'])(
    'allows unused ports with %s',
    (status) => {
      expect(() => assertServePortAvailable(status, 443)).not.toThrow();
    }
  );
  it.each([
    { TCP: { '443': { HTTPS: true } } },
    { Web: { 'mac.tail.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } },
    { Foreground: { session: { TCP: { '443': { HTTPS: true } } } } },
    { AllowFunnel: { 'mac.tail.ts.net:443': true } },
  ])('refuses an occupied or public endpoint: %j', (config) => {
    expect(() => assertServePortAvailable(JSON.stringify(config), 443)).toThrow(
      /443.*--https-port/
    );
  });
  it.each(['invalid', '[]', '{"TCP":42}', '{"Foreground":{"session":false}}'])(
    'fails closed on invalid config %s',
    (status) => {
      expect(() => assertServePortAvailable(status, 443)).toThrow(/tailscale serve status --json/i);
    }
  );
});

it.each(['0', '65536', '1.5', '443x', '-1', ''])('rejects invalid port %s', (value) => {
  expect(() => parsePort(value)).toThrow();
});

it.each([
  ['1', 1],
  ['443', 443],
  ['65535', 65_535],
] as const)('accepts valid port %s', (value, port) => {
  expect(parsePort(value)).toBe(port);
});
