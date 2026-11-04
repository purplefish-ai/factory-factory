import { afterEach, expect, it, vi } from 'vitest';
import { configService } from './config.service';

vi.mock('@/backend/lib/app-version', () => ({ readAppVersion: () => undefined }));
afterEach(() => {
  vi.unstubAllEnvs();
  configService.reload();
});

it('reports an unknown app version if its manifest cannot be read, regardless of the launcher version', () => {
  vi.stubEnv('npm_package_version', '9.9.9');
  configService.reload();
  expect(configService.getAppVersion()).toBe('unknown');
});
