import { describe, expect, it } from 'vitest';
import { isLoopbackRemoteAddress, isOriginAllowed, isTrustedLocalAddress } from './request-trust';

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
  });
});
