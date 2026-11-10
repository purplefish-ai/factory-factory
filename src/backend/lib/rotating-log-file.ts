import {
  closeSync,
  createWriteStream,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  type WriteStream,
} from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

interface RotatingLogFileOptions {
  path: string;
  /** Rotate once the current file reaches this many bytes. */
  maxBytes: number;
  /** Rotated files kept as `<path>.1` (newest) to `<path>.<maxRotatedFiles>`. */
  maxRotatedFiles: number;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function rotatedPath(path: string, index: number): string {
  return `${path}.${index}`;
}

/**
 * Append-only log file with size-based rotation.
 *
 * The size is read once when the file is opened and then tracked in-process
 * from the bytes handed to the stream, so ordinary writes never touch the file
 * system synchronously. Crossing `maxBytes` shifts `<path>` to `<path>.1` (and
 * each `<path>.N` to `<path>.N+1`, dropping the oldest) with a few renames, then
 * opens a fresh `<path>` on the next write. The descriptor is opened
 * synchronously, so writes still buffered in the old stream land in `<path>.1`:
 * the descriptor follows the renamed file. A file already over the limit when
 * it is opened is rotated before writing.
 *
 * Sink failures are never reported through a logger; the caller owns fallback.
 */
export class RotatingLogFile {
  readonly path: string;
  private readonly maxBytes: number;
  private readonly maxRotatedFiles: number;
  private stream: WriteStream | null = null;
  private size = 0;

  constructor(options: RotatingLogFileOptions) {
    this.path = options.path;
    this.maxBytes = options.maxBytes;
    this.maxRotatedFiles = Math.max(1, options.maxRotatedFiles);
  }

  write(line: string): void {
    const stream = this.stream ?? this.open();
    if (!stream) {
      return;
    }
    stream.write(line);
    this.size += Buffer.byteLength(line);
    if (this.size >= this.maxBytes) {
      this.rotate();
    }
  }

  private open(): WriteStream | null {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      let file = openForAppend(this.path);
      if (file.size >= this.maxBytes) {
        closeSync(file.fd);
        try {
          this.shiftFiles();
        } catch {
          // Keep appending to the oversized file; retry after another maxBytes.
        }
        file = openForAppend(this.path);
        file.size = 0;
      }
      this.size = file.size;
      const stream = createWriteStream(this.path, { fd: file.fd });
      stream.on('error', () => {
        if (this.stream === stream) {
          this.stream = null;
        }
      });
      this.stream = stream;
      return stream;
    } catch {
      return null;
    }
  }

  private rotate(): void {
    const previous = this.stream;
    // Reset first: a failed shift keeps appending to the current file and only
    // retries after another maxBytes, rather than on every following write.
    this.size = 0;
    try {
      this.shiftFiles();
    } catch {
      return;
    }
    this.stream = null;
    previous?.end();
  }

  private shiftFiles(): void {
    unlinkIfPresent(rotatedPath(this.path, this.maxRotatedFiles));
    for (let index = this.maxRotatedFiles - 1; index >= 1; index--) {
      renameIfPresent(rotatedPath(this.path, index), rotatedPath(this.path, index + 1));
    }
    renameIfPresent(this.path, rotatedPath(this.path, 1));
  }
}

function openForAppend(path: string): { fd: number; size: number } {
  const fd = openSync(path, 'a');
  try {
    return { fd, size: fstatSync(fd).size };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function renameIfPresent(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

/**
 * Delete rotated copies of `path` (`<path>.1` to `<path>.<maxRotatedFiles>`)
 * last modified before `cutoffMs`. The live file is never touched, and a file
 * that cannot be inspected or removed is skipped. Returns the number deleted.
 */
export async function pruneRotatedLogFiles(
  path: string,
  maxRotatedFiles: number,
  cutoffMs: number
): Promise<number> {
  let deleted = 0;
  for (let index = 1; index <= Math.max(1, maxRotatedFiles); index++) {
    const candidate = rotatedPath(path, index);
    try {
      if ((await stat(candidate)).mtimeMs < cutoffMs) {
        await unlink(candidate);
        deleted++;
      }
    } catch {
      // Missing or busy rotated files are left for the next startup.
    }
  }
  return deleted;
}
