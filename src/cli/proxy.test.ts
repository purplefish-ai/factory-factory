import { describe, expect, it } from 'vitest';
import { proxyInternals } from './proxy';

describe('proxy internals', () => {
  it('generates a six-character alphanumeric password', () => {
    const password = proxyInternals.generatePassword();

    expect(password).toHaveLength(6);
    expect(password).toMatch(/^[a-z0-9]{6}$/);
  });

  it('generates a 128-bit magic token as hex', () => {
    const token = proxyInternals.generateMagicToken();

    expect(token).toHaveLength(32);
    expect(token).toMatch(/^[a-f0-9]{32}$/);
  });

  it('signs and verifies session values', () => {
    const secret = Buffer.from('super-secret-key');
    const session = proxyInternals.createSessionValue(secret);
    const cookieValue = `${session.id}.${session.signature}`;

    expect(proxyInternals.verifySessionValue(cookieValue, secret)).toBe(true);
    expect(proxyInternals.verifySessionValue(`${session.id}.tampered`, secret)).toBe(false);
  });

  it('extracts trycloudflare URL from mixed output', () => {
    const output =
      'INF Starting\nINF Visit this URL to access your application: https://abc-xyz.trycloudflare.com';

    expect(proxyInternals.extractTryCloudflareUrl(output)).toBe(
      'https://abc-xyz.trycloudflare.com'
    );
  });

  it('tracks per-IP lockout and global lockout thresholds', () => {
    const guard = new proxyInternals.BruteForceGuard();
    const ip = '203.0.113.10';

    const first = guard.registerFailure(ip, 0);
    expect(first.ipLocked).toBe(false);
    expect(first.globalLocked).toBe(false);

    for (let i = 1; i < 4; i += 1) {
      const result = guard.registerFailure(ip, i);
      expect(result.ipLocked).toBe(false);
    }

    const fifth = guard.registerFailure(ip, 5);
    expect(fifth.ipLocked).toBe(true);

    const lockedState = guard.isLocked(ip, 6);
    expect(lockedState.locked).toBe(true);

    const unlockedState = guard.isLocked(ip, 5 * 60 * 1000 + 10);
    expect(unlockedState.locked).toBe(false);

    let globalLockReached = false;
    for (let i = 0; i < 19; i += 1) {
      const result = guard.registerFailure(`198.51.100.${i}`, i + 100);
      if (result.globalLocked) {
        globalLockReached = true;
        break;
      }
    }

    expect(globalLockReached).toBe(true);
  });
});
