import { constants, type Stats } from 'node:fs';
import { open, readlink, stat } from 'node:fs/promises';
import { MAX_FILE_SIZE } from './file-helpers';

// Darwin exposes O_NOFOLLOW_ANY in sys/fcntl.h, but Node does not export it.
const DARWIN_NO_SYMLINKS = 0x20_00_00_00;

function assertRegularFile(stats: Stats) {
  if (!stats.isFile()) {
    throw new Error(stats.isDirectory() ? 'Path is a directory' : 'Path is not a regular file');
  }
}

async function assertOpenedPath(fd: number, withinDirectory: string | undefined) {
  // O_NOFOLLOW only covers the final component on Linux. Check where the
  // opened descriptor actually points before reading any bytes.
  if (withinDirectory && process.platform === 'linux') {
    const openedPath = await readlink(`/proc/self/fd/${fd}`);
    if (!openedPath.startsWith(`${withinDirectory}/`)) {
      throw new Error('Invalid file path');
    }
  }
}

/** Read at most one preview plus a byte of lookahead, even if the file grows. */
export async function readFilePrefix(
  fullPath: string,
  {
    maxBytes = MAX_FILE_SIZE,
    noFollow = false,
    withinDirectory,
    validateFile,
  }: {
    maxBytes?: number;
    noFollow?: boolean;
    withinDirectory?: string;
    validateFile?: (stats: Stats) => Promise<void>;
  } = {}
) {
  assertRegularFile(await stat(fullPath));
  // A regular file can be replaced with a FIFO between stat and open.
  const symlinkFlags =
    withinDirectory && process.platform === 'darwin'
      ? DARWIN_NO_SYMLINKS
      : noFollow || withinDirectory
        ? constants.O_NOFOLLOW
        : 0;
  const handle = await open(fullPath, constants.O_RDONLY | constants.O_NONBLOCK | symlinkFlags);
  try {
    const stats = await handle.stat();
    assertRegularFile(stats);
    await assertOpenedPath(handle.fd, withinDirectory);
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
