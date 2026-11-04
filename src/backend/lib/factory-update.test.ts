import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FactoryReleaseChecker, isNewerRelease } from './factory-update';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([
  ['0.5.3', '0.5.4', true],
  ['0.9.0', '0.10.0', true],
  ['1.0.0', '0.99.0', false],
  ['1.0.0', '1.0.0', false],
  ['1.0.0-beta.1', '1.0.0', true],
  ['1.0.0', '1.1.0-beta.1', false],
  ['unknown', '1.0.0', false],
  ['1.0.0', 'bad', false],
])('compares %s with stable release %s', (current, latest, expected) => {
  expect(isNewerRelease(current, latest)).toBe(expected);
});

it('coalesces requests and caches registry responses for an hour', async () => {
  let version = '0.6.0';
  const fetcher = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ version }))));
  vi.stubGlobal('fetch', fetcher);
  const checker = new FactoryReleaseChecker();
  expect(await Promise.all([checker.getLatestVersion(), checker.getLatestVersion()])).toEqual([
    '0.6.0',
    '0.6.0',
  ]);
  await checker.getLatestVersion();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith(
    'https://registry.npmjs.org/factory-factory/latest',
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  );
  version = '0.7.0';
  vi.advanceTimersByTime(60 * 60 * 1000);
  expect(await checker.getLatestVersion()).toBe('0.7.0');
  expect(await checker.getLatestVersion()).toBe('0.7.0');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([
  () => Promise.reject(new Error('offline')),
  () => Promise.resolve(new Response('unavailable', { status: 503 })),
  () => Promise.resolve(new Response('not JSON')),
  () => Promise.resolve(new Response(JSON.stringify({ version: 123 }))),
  () => Promise.resolve(new Response(JSON.stringify({ version: '1.0.0-beta' }))),
])('treats unavailable or invalid registry data as unknown and backs off', async (fetcher) => {
  const fetchMock = vi.fn(fetcher);
  vi.stubGlobal('fetch', fetchMock);
  const checker = new FactoryReleaseChecker();
  expect(await checker.getLatestVersion()).toBeNull();
  expect(await checker.getLatestVersion()).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(5 * 60 * 1000);
  await checker.getLatestVersion();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('retains a known release during a registry outage', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ version: '0.6.0' })))
    .mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetcher);
  const checker = new FactoryReleaseChecker();
  expect(await checker.getLatestVersion()).toBe('0.6.0');
  vi.advanceTimersByTime(60 * 60 * 1000);
  expect(await checker.getLatestVersion()).toBe('0.6.0');
});

it('bounds a hung registry request with a three-second timeout', async () => {
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('timed out')), {
            once: true,
          });
        })
    )
  );
  try {
    const result = new FactoryReleaseChecker().getLatestVersion();
    expect(timeout).toHaveBeenCalledWith(3000);
    controller.abort();
    expect(await result).toBeNull();
  } finally {
    timeout.mockRestore();
  }
});

it('reports a registry failure to the caller for diagnostics', async () => {
  const error = new Error('registry offline');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
  const onError = vi.fn();
  expect(await new FactoryReleaseChecker().getLatestVersion(onError)).toBeNull();
  expect(onError).toHaveBeenCalledWith(error);
});

it('keeps registry failures non-blocking even if diagnostics throw', async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetcher);
  const checker = new FactoryReleaseChecker();
  const onError = () => {
    throw new Error('logging failed');
  };
  expect(await checker.getLatestVersion(onError)).toBeNull();
  expect(await checker.getLatestVersion(onError)).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
