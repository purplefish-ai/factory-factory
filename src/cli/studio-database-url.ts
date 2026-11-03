export function getStudioDatabaseUrl(databasePath: string, platform = process.platform): string {
  const path = platform === 'win32' ? databasePath.replaceAll('\\', '/') : databasePath;
  // Prisma's filesystem resolver drops Windows network/device path roots.
  if (platform === 'win32' && path.startsWith('//')) {
    throw new Error(
      'Prisma Studio does not support Windows UNC or device database paths. Use a local drive path.'
    );
  }
  // Studio treats the file: suffix as a filesystem path without URL decoding.
  return `file://${path}`;
}
