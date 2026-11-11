import { describe, expect, it } from 'vitest';
import {
  isBrowserOriginAllowed,
  isHostHeaderAllowed,
  isLoopbackBindHost,
  isLoopbackRemoteAddress,
  isOriginAllowed,
  isTrustedLocalAddress,
  shouldAllowOwnLoopbackOrigin,
} from './request-trust';

describe('request trust helpers', () => {
  describe('isLoopbackRemoteAddress', () => {
    it('accepts IPv4, IPv4-mapped IPv6, and IPv6 loopback addresses', () => {
      expect(isLoopbackRemoteAddress('127.0.0.1')).toBe(true);
      expect(isLoopbackRemoteAddress('127.42.0.9')).toBe(true);
      expect(isLoopbackRemoteAddress('::ffff:127.0.0.1')).toBe(true);
      expect(isLoopbackRemoteAddress('::1')).toBe(true);
    });

    it('rejects non-loopback addresses', () => {
      expect(isLoopbackRemoteAddress('172.17.0.1')).toBe(false);
      expect(isLoopbackRemoteAddress('203.0.113.10')).toBe(false);
      expect(isLoopbackRemoteAddress(undefined)).toBe(false);
    });
  });

  describe('isTrustedLocalAddress', () => {
    it('accepts loopback addresses without extra CIDR configuration', () => {
      expect(isTrustedLocalAddress('127.0.0.1')).toBe(true);
    });

    it('accepts addresses covered by configured trusted local CIDRs', () => {
      expect(isTrustedLocalAddress('172.17.0.1', ['172.17.0.1/32'])).toBe(true);
      expect(isTrustedLocalAddress('172.18.0.42', ['172.18.0.0/16'])).toBe(true);
    });

    it('rejects addresses outside configured trusted local CIDRs', () => {
      expect(isTrustedLocalAddress('172.18.0.42', ['172.17.0.1/32'])).toBe(false);
      expect(isTrustedLocalAddress('203.0.113.10', ['172.17.0.1/32'])).toBe(false);
      expect(isTrustedLocalAddress('172.17.0.1', ['not-a-cidr'])).toBe(false);
    });
  });

  describe('isOriginAllowed', () => {
    it('accepts exact allowed origins', () => {
      expect(isOriginAllowed('https://example.com', ['https://example.com'])).toBe(true);
    });

    it('treats loopback host aliases as equivalent for the same scheme and port', () => {
      expect(isOriginAllowed('http://127.0.0.1:3000', ['http://localhost:3000'])).toBe(true);
      expect(isOriginAllowed('http://localhost:3000', ['http://127.0.0.1:3000'])).toBe(true);
      expect(isOriginAllowed('http://127.42.0.9:3000', ['http://localhost:3000'])).toBe(true);
    });

    it('treats explicit default ports as canonical loopback origins', () => {
      expect(isOriginAllowed('http://127.0.0.1:80', ['http://localhost'])).toBe(true);
      expect(isOriginAllowed('http://localhost', ['http://127.0.0.1:80'])).toBe(true);
      expect(isOriginAllowed('https://127.0.0.1:443', ['https://localhost'])).toBe(true);
      expect(isOriginAllowed('https://localhost', ['https://127.0.0.1:443'])).toBe(true);
    });

    it('does not match loopback aliases across schemes or ports', () => {
      expect(isOriginAllowed('http://127.0.0.1:3001', ['http://localhost:3000'])).toBe(false);
      expect(isOriginAllowed('https://127.0.0.1:3000', ['http://localhost:3000'])).toBe(false);
    });

    it('does not normalize non-loopback hosts', () => {
      expect(isOriginAllowed('https://app.example.com', ['https://example.com'])).toBe(false);
      expect(isOriginAllowed('not a url', ['http://localhost:3000'])).toBe(false);
    });

    it('rejects loopback aliases with URL credentials or extra components', () => {
      expect(isOriginAllowed('http://evil@localhost:3000', ['http://localhost:3000'])).toBe(false);
      expect(isOriginAllowed('http://localhost:3000/path', ['http://127.0.0.1:3000'])).toBe(false);
      expect(isOriginAllowed('http://localhost:3000?x=1', ['http://127.0.0.1:3000'])).toBe(false);
      expect(isOriginAllowed('http://localhost:3000#hash', ['http://127.0.0.1:3000'])).toBe(false);
      expect(isOriginAllowed('http://localhost:3000/', ['http://127.0.0.1:3000'])).toBe(false);
      expect(isOriginAllowed('http://localhost:80/', ['http://127.0.0.1'])).toBe(false);
    });

    it('allows any origin when disableCorsChecks is set', () => {
      expect(isOriginAllowed('https://attacker.example', [], true)).toBe(true);
      expect(isOriginAllowed('not a url', ['http://localhost:3000'], true)).toBe(true);
    });
  });

  describe('shouldAllowOwnLoopbackOrigin', () => {
    const localOrigins = ['http://localhost:3000', 'http://127.0.0.1:3001', 'http://[::1]:5173'];

    it.each([undefined, 'localhost', '127.0.0.1', '::1'])(
      'implies the own origin for a loopback bind (%s) with loopback origins only',
      (bindHost) => {
        expect(shouldAllowOwnLoopbackOrigin(bindHost, localOrigins)).toBe(true);
      }
    );

    it.each(['0.0.0.0', '::', '192.168.1.20'])('never implies it for a %s bind', (bindHost) => {
      expect(shouldAllowOwnLoopbackOrigin(bindHost, localOrigins)).toBe(false);
    });

    it.each([
      ['ff tailscale', ['https://mac.tail123.ts.net']],
      ['a reverse proxy', ['https://ff.example.com', 'http://localhost:3001']],
      ['a malformed entry', ['http://localhost:3001', '']],
    ])('keeps the configured list only with %s', (_label, allowedOrigins) => {
      expect(shouldAllowOwnLoopbackOrigin('127.0.0.1', allowedOrigins)).toBe(false);
    });
  });

  describe('isBrowserOriginAllowed', () => {
    const loopbackBound = {
      allowedOrigins: ['http://localhost:3001'],
      allowOwnLoopbackOrigin: true,
    };

    it.each(['http://localhost:3002', 'http://127.0.0.1:3002', 'http://[::1]:3002'])(
      'accepts its own loopback origin %s on the port the request arrived on',
      (origin) => {
        expect(isBrowserOriginAllowed(origin, loopbackBound, 3002)).toBe(true);
      }
    );

    it('accepts its own loopback origin on the default HTTP port', () => {
      expect(isBrowserOriginAllowed('http://localhost', loopbackBound, 80)).toBe(true);
    });

    it.each([
      ['a loopback origin on another port', 'http://localhost:3003'],
      ['a non-loopback host on the same port', 'http://attacker.example:3002'],
      ['a LAN address on the same port', 'http://192.168.1.20:3002'],
      ['an https origin on the same port', 'https://localhost:3002'],
      ['an origin with a path', 'http://localhost:3002/'],
      ['an origin with credentials', 'http://evil@localhost:3002'],
      ['the opaque origin', 'null'],
    ])('rejects %s', (_label, origin) => {
      expect(isBrowserOriginAllowed(origin, loopbackBound, 3002)).toBe(false);
    });

    it('does not allow its own origin unless bound to loopback', () => {
      const policy = { ...loopbackBound, allowOwnLoopbackOrigin: false };
      expect(isBrowserOriginAllowed('http://localhost:3002', policy, 3002)).toBe(false);
      expect(isBrowserOriginAllowed('http://localhost:3002', { allowedOrigins: [] }, 3002)).toBe(
        false
      );
    });

    it('does not allow its own origin without the connection port', () => {
      expect(isBrowserOriginAllowed('http://localhost:3002', loopbackBound, undefined)).toBe(false);
    });

    it('keeps the configured origins and the disableCorsChecks bypass', () => {
      expect(isBrowserOriginAllowed('http://127.0.0.1:3001', loopbackBound, 3002)).toBe(true);
      expect(
        isBrowserOriginAllowed(
          'https://attacker.example',
          { allowedOrigins: [], disableCorsChecks: true },
          undefined
        )
      ).toBe(true);
    });
  });

  describe('isLoopbackBindHost', () => {
    it.each([
      undefined,
      'localhost',
      'LOCALHOST',
      '127.0.0.1',
      '127.1.2.3',
      '::1',
      '[::1]',
      '0:0::1',
      '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1',
    ])('treats %s as a loopback bind', (host) => {
      expect(isLoopbackBindHost(host)).toBe(true);
    });

    it.each([
      '0.0.0.0',
      '::',
      '0:0::0',
      '192.168.1.20',
      'mac.local',
      '[::]',
      'fe80::1',
      'fe80::1%eth0',
    ])('treats %s as reachable beyond loopback', (host) => {
      expect(isLoopbackBindHost(host)).toBe(false);
    });
  });

  describe('isHostHeaderAllowed', () => {
    const allowedOrigins = ['http://localhost:3000', 'https://mac.tail123.ts.net'];

    it.each(['localhost:3001', 'LOCALHOST:3001', '127.0.0.1:3001', '[::1]:3001', 'localhost'])(
      'accepts loopback Host %s',
      (host) => {
        expect(isHostHeaderAllowed(host, allowedOrigins)).toBe(true);
      }
    );

    it('accepts the hostname of a configured allowed origin on any port', () => {
      expect(isHostHeaderAllowed('mac.tail123.ts.net', allowedOrigins)).toBe(true);
      expect(isHostHeaderAllowed('MAC.tail123.ts.net:8443', allowedOrigins)).toBe(true);
    });

    it.each([
      'attacker.example:3001',
      'localhost.attacker.example',
      'localhost@attacker.example',
      'localhost/path',
      '192.168.1.20:3001',
      '',
    ])('rejects rebound or malformed Host %j', (host) => {
      expect(isHostHeaderAllowed(host, allowedOrigins)).toBe(false);
    });
  });
});
