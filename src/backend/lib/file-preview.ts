import { open } from 'node:fs/promises';
import { MAX_FILE_SIZE } from './file-helpers';

/** Read at most one preview plus a byte of lookahead, even if the file grows. */
export async function readFilePrefix(fullPath: string) {
  const handle = await open(fullPath, 'r');
  try {
    const stats = await handle.stat();
    if (stats.isDirectory()) {
      throw new Error('Path is a directory');
    }

    const buffer = Buffer.allocUnsafe(MAX_FILE_SIZE + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }

    return {
      buffer: buffer.subarray(0, Math.min(offset, MAX_FILE_SIZE)),
      size: stats.size,
      truncated: stats.size > MAX_FILE_SIZE || offset > MAX_FILE_SIZE,
    };
  } finally {
    await handle.close();
  }
}
