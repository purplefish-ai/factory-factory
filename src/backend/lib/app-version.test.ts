import { afterEach, expect, it, vi } from 'vitest';
import { readAppVersion } from './app-version';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  path: '/install/dist/src/backend/lib/app-version.js',
}));
vi.mock('node:fs', () => ({ readFileSync: (path: string) => mocks.read(path) }));
vi.mock('node:url', () => ({ fileURLToPath: () => mocks.path }));
afterEach(() => vi.clearAllMocks());

it.each([
  ['/install/dist/src/backend/lib/app-version.js', '/install/package.json'],
  [
    '/Applications/Factory.app/Contents/Resources/app.asar.unpacked/dist/src/backend/lib/app-version.js',
    '/Applications/Factory.app/Contents/Resources/app.asar/package.json',
  ],
])('reads Factory’s own manifest from %s', (modulePath, manifestPath) => {
  mocks.path = modulePath;
  mocks.read.mockImplementation((path: string) => {
    if (path === manifestPath) {
      return JSON.stringify({ name: 'factory-factory', version: '1.2.3' });
    }
    throw new Error('not found');
  });
  expect(readAppVersion()).toBe('1.2.3');
});

it('returns unknown when no valid Factory manifest exists', () => {
  mocks.read.mockReturnValue(JSON.stringify({ name: 'another-package', version: '99.0.0' }));
  expect(readAppVersion()).toBeUndefined();
});
