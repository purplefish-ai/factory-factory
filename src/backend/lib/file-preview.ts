import { constants, type Stats } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { MAX_FILE_SIZE } from './file-helpers';

function assertRegularFile(stats: Stats) {
  if (!stats.isFile()) {
    throw new Error(stats.isDirectory() ? 'Path is a directory' : 'Path is not a regular file');
  }
}

/** Read at most one preview plus a byte of lookahead, even if the file grows. */
export async function readFilePrefix(
  fullPath: string,
  {
    maxBytes = MAX_FILE_SIZE,
    noFollow = false,
    validateFile,
  }: { maxBytes?: number; noFollow?: boolean; validateFile?: (stats: Stats) => Promise<void> } = {}
) {
  assertRegularFile(await stat(fullPath));
  // A regular file can be replaced with a FIFO between stat and open.
  const handle = await open(
    fullPath,
    constants.O_RDONLY | constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW : 0)
  );
  try {
    const stats = await handle.stat();
    assertRegularFile(stats);
    await validateFile?.(stats);

    let buffer = Buffer.allocUnsafe(Math.min(maxBytes, stats.size) + 1);
    let offset = 0;
    while (offset < maxBytes + 1) {
      if (offset === buffer.length) {
        // Files can grow after stat; expand only when bytes fill the current buffer.
        const expanded = Buffer.allocUnsafe(Math.min(maxBytes + 1, buffer.length * 2));
        buffer.copy(expanded);
        buffer = expanded;
      }
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }

    // Recheck identity/containment before publishing bytes if a caller supplies
    // a filesystem boundary, including mutations that happen during the read.
    await validateFile?.(stats);
    return {
      buffer: buffer.subarray(0, Math.min(offset, maxBytes)),
      size: stats.size,
      truncated: stats.size > maxBytes || offset > maxBytes,
    };
  } finally {
    await handle.close();
  }
}
