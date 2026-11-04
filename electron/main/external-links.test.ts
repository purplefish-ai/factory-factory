import { describe, expect, it } from 'vitest';
import { classifyNavigation, getAppOrigin } from './external-links.js';

describe('getAppOrigin', () => {
  it('returns the origin of http(s) app URLs', () => {
    expect(getAppOrigin('http://127.0.0.1:3001/')).toBe('http://127.0.0.1:3001');
    expect(getAppOrigin('http://localhost:5173/projects')).toBe('http://localhost:5173');
    expect(getAppOrigin('https://example.com')).toBe('https://example.com');
  });

  it('returns null for URLs without a usable web origin', () => {
    expect(getAppOrigin('data:text/html,hi')).toBeNull();
    expect(getAppOrigin('file:///app/index.html')).toBeNull();
    expect(getAppOrigin('not a url')).toBeNull();
  });
});

describe('classifyNavigation', () => {
  const appOrigin = 'http://127.0.0.1:3001';

  it('keeps URLs on the app origin internal', () => {
    expect(classifyNavigation('http://127.0.0.1:3001/projects/a?x=1#y', appOrigin)).toEqual({
      action: 'internal',
    });
  });

  it('opens other web origins externally, including other loopback ports', () => {
    for (const url of [
      'https://github.com/org/repo/pull/1',
      'http://localhost:3001/',
      'http://127.0.0.1:5173/',
      'https://127.0.0.1:3001/',
    ]) {
      expect(classifyNavigation(url, appOrigin)).toEqual({ action: 'external', url });
    }
  });

  it('opens mailto links externally', () => {
    expect(classifyNavigation('mailto:team@example.com', appOrigin)).toEqual({
      action: 'external',
      url: 'mailto:team@example.com',
    });
  });

  it('passes the normalized URL to the system', () => {
    expect(classifyNavigation('HTTPS://Example.COM/a b', appOrigin)).toEqual({
      action: 'external',
      url: 'https://example.com/a%20b',
    });
  });

  it('treats every web URL as external while no app is loaded', () => {
    expect(classifyNavigation('http://127.0.0.1:3001/', null)).toEqual({
      action: 'external',
      url: 'http://127.0.0.1:3001/',
    });
  });

  it('denies unsupported schemes and unparseable URLs', () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'blob:http://127.0.0.1:3001/uuid',
      'vscode://file/Users/me/project',
      'ftp://example.com/file',
      'about:blank',
      '/relative/path',
      '',
    ]) {
      expect(classifyNavigation(url, appOrigin)).toEqual({ action: 'deny' });
    }
  });
});
