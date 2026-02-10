import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface WriteFileAtomicOptions {
  encoding?: BufferEncoding;
  mode?: number;
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

  const tmpPath = path.join(directory, `.tmp-${randomUUID()}`);

  if (typeof content === 'string') {
    await fs.writeFile(tmpPath, content, {
      encoding: options.encoding ?? 'utf-8',
      mode: options.mode,
    });
  } else {
    await fs.writeFile(tmpPath, content, {
      mode: options.mode,
    });
  }

  try {
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {
      // Best-effort cleanup; ignore if already removed.
    });
    throw error;
  }
}
