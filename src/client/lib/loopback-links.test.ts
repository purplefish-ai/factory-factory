import { describe, expect, it } from 'vitest';
import { isLoopbackHostname, toPortShareLink } from './loopback-links';

describe('toPortShareLink', () => {
  it.each([
    ['http://127.0.0.1:6173/?path=/story/chat--prose', '/proxy/6173/?path=/story/chat--prose'],
    ['http://localhost:5173', '/proxy/5173/'],
    ['http://[::1]:3000/a/b#section', '/proxy/3000/a/b#section'],
    ['http://0.0.0.0:8080/x?y=1', '/proxy/8080/x?y=1'],
    ['http://app.localhost:4000/', '/proxy/4000/'],
    ['http://127.0.1.1:4321/', '/proxy/4321/'],
    ['http://localhost.:5173/a', '/proxy/5173/a'],
  ])('maps %s to %s', (href, expected) => {
    expect(toPortShareLink(href)?.href).toBe(expected);
  });

  it.each([
    'https://localhost:5173/',
    'http://localhost/',
    'http://example.com:5173/',
    'http://10.0.0.5:5173/',
    '/relative/path',
    'not a url',
  ])('leaves %s alone', (href) => {
    expect(toPortShareLink(href)).toBeNull();
  });
});

describe('isLoopbackHostname', () => {
  it('recognizes loopback page hosts but not Tailscale names', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isLoopbackHostname('localhost.')).toBe(true);
    expect(isLoopbackHostname('mac.tail123.ts.net')).toBe(false);
  });
});
