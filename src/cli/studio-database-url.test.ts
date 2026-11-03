import { expect, it } from 'vitest';
import { getStudioDatabaseUrl } from './studio-database-url';

it.each([
  ['/home/user/requested database #%.db', 'linux', 'file:///home/user/requested database #%.db'],
  [
    'C:\\Users\\test\\requested database #%.db',
    'win32',
    'file://C:/Users/test/requested database #%.db',
  ],
  ['D:/data/requested.db', 'win32', 'file://D:/data/requested.db'],
] as const)('preserves the SQLite filesystem path for %s', (path, platform, url) => {
  expect(getStudioDatabaseUrl(path, platform)).toBe(url);
});

it.each([
  '\\\\server\\share\\data.db',
  '//server/share/data.db',
  '\\\\?\\UNC\\server\\share\\data.db',
  '\\\\?\\C:\\data.db',
])('rejects unsupported Windows path %s before Prisma can open a different location', (path) => {
  expect(() => getStudioDatabaseUrl(path, 'win32')).toThrow(/UNC or device database paths/);
});
