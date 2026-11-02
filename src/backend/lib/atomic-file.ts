import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface WriteFileAtomicOptions {
  encoding?: BufferEncoding;
  mode?: number;
  temporaryFileTag?: string;
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
  await fs.mkdir(directory, { recursive: true });

  const tag = options.temporaryFileTag;
  if (tag !== undefined && !/^[a-zA-Z0-9-]{1,128}$/.test(tag)) {
    throw new Error('Invalid atomic-file temporary tag');
  }
  const tmpPath = path.join(directory, `.tmp-${tag ? `${tag}-` : ''}${randomUUID()}`);

  try {
    if (typeof content === 'string') {
      await fs.writeFile(tmpPath, content, {
        encoding: options.encoding ?? 'utf-8',
        mode: options.mode,
      });
    } else {
      await fs.writeFile(tmpPath, content, { mode: options.mode });
    }
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {
      // Best-effort cleanup; ignore if already removed.
    });
    throw error;
  }
}
