import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface WriteFileAtomicOptions {
  encoding?: BufferEncoding;
  mode?: number;
  temporaryFileTag?: string;
  /** Flush bytes and directory entries before the caller releases its recovery proof. */
  durable?: boolean;
  /** Also sync existing ancestors to this boundary (e.g. concurrently created archive dirs). */
  durableDirectoryRoot?: string;
}

/** The file was synced/renamed, but Windows cannot flush this directory handle.
 * Callers must retain another durable copy before treating publication as complete.
 */
export class DirectorySyncUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Windows directory sync is unavailable; retain durable source bytes', { cause });
    this.name = 'DirectorySyncUnavailableError';
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (
      process.platform === 'win32' &&
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      ['EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes(error.code)
    ) {
      throw new DirectorySyncUnavailableError(error);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function writeDurableTemporary(
  path: string,
  content: string | Buffer,
  options: WriteFileAtomicOptions
): Promise<void> {
  const handle = await fs.open(path, 'wx', options.mode);
  try {
    await handle.writeFile(content, { encoding: options.encoding ?? 'utf-8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryChain(directory: string, root: string): Promise<void> {
  const ancestor = path.resolve(root);
  const within = path.relative(ancestor, path.resolve(directory));
  if (within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
    throw new Error('Durable directory root must contain target directory');
  }
  for (let parent = path.resolve(directory); ; parent = path.dirname(parent)) {
    await syncDirectory(parent);
    if (parent === ancestor) {
      return;
    }
  }
}

/**
 * Atomically write content by writing to a temp file in the same directory
 * and renaming it into place.
 */
export async function writeFileAtomic(
  targetPath: string,
  content: string | Buffer,
  options: WriteFileAtomicOptions = {}
): Promise<void> {
  const directory = path.dirname(targetPath);
  const created = await fs.mkdir(directory, { recursive: true });

  const tag = options.temporaryFileTag;
  if (tag !== undefined && !/^[a-zA-Z0-9-]{1,128}$/.test(tag)) {
    throw new Error('Invalid atomic-file temporary tag');
  }
  const tmpPath = path.join(directory, `.tmp-${tag ? `${tag}-` : ''}${randomUUID()}`);

  try {
    if (options.durable) {
      await writeDurableTemporary(tmpPath, content, options);
    } else if (typeof content === 'string') {
      await fs.writeFile(tmpPath, content, {
        encoding: options.encoding ?? 'utf-8',
        mode: options.mode,
      });
    } else {
      await fs.writeFile(tmpPath, content, { mode: options.mode });
    }
    await fs.rename(tmpPath, targetPath);
    if (options.durable) {
      // Recursive mkdir can introduce multiple new directory entries. Their
      // parents must be durable too, before the pending DB copy is cleared.
      await syncDirectoryChain(
        directory,
        options.durableDirectoryRoot ?? (created ? path.dirname(created) : directory)
      );
    }
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {
      // Best-effort cleanup; ignore if already removed.
    });
    throw error;
  }
}
