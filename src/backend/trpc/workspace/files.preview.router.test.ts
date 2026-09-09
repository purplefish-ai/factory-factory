import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockWorkspace = vi.hoisted(() => vi.fn());
vi.mock('./workspace-helpers', () => ({
  getWorkspaceWithWorktreeOrThrow: mockWorkspace,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

import { workspaceFilesRouter } from './files.trpc';

const LIMIT = 1024 * 1024;
const caller = workspaceFilesRouter.createCaller({ appContext: { services: {} } } as never);
const readPreview = () => caller.readFile({ workspaceId: 'w1', path: 'preview.txt' });

describe('workspace file previews', () => {
  let rootDir: string;
  let chunkSize: number | undefined;
  let readError: Error | undefined;
  let replaceOnRead: string | undefined;
  let replaceWithFifoOnOpen: boolean;
  const readLengths: number[] = [];
  const handles: Awaited<ReturnType<typeof open>>[] = [];

  beforeEach(async () => {
    vi.restoreAllMocks();
    chunkSize = undefined;
    readError = undefined;
    replaceOnRead = undefined;
    replaceWithFifoOnOpen = false;
    readLengths.length = 0;
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(open).mockImplementation(async (...args) => {
      if (replaceWithFifoOnOpen) {
        replaceWithFifoOnOpen = false;
        await rm(join(rootDir, 'preview.txt'));
        execFileSync('mkfifo', [join(rootDir, 'preview.txt')]);
      }
      const handle = await actual.open(...args);
      handles.push(handle);
      const originalRead = handle.read;
      vi.spyOn(handle, 'read').mockImplementation(async (...args: unknown[]) => {
        if (readError) {
          throw readError;
        }
        if (replaceOnRead !== undefined) {
          await writeFile(join(rootDir, 'preview.txt'), replaceOnRead);
          replaceOnRead = undefined;
        }
        if (chunkSize && typeof args[2] === 'number') {
          args[2] = Math.min(args[2], chunkSize);
        }
        readLengths.push(Number(args[2]));
        return Reflect.apply(originalRead, handle, args);
      });
      vi.spyOn(handle, 'readFile');
      vi.spyOn(handle, 'close');
      return handle;
    });
    rootDir = join(tmpdir(), `file-preview-${crypto.randomUUID()}`);
    await mkdir(rootDir);
    mockWorkspace.mockResolvedValue({ worktreePath: rootDir });
  });

  afterEach(async () => {
    for (const handle of handles.splice(0)) {
      await handle.close();
    }
    await rm(rootDir, { recursive: true, force: true });
  });

  it.each([false, true])('bounds reads of a large sparse file (binary: %s)', async (binary) => {
    const handle = await open(join(rootDir, 'preview.txt'), 'w');
    const prefix = Buffer.alloc(LIMIT + 1, 'a');
    if (binary) {
      prefix[0] = 0;
    }
    await handle.write(prefix);
    await handle.truncate(512 * LIMIT);
    await handle.close();

    const result = await readPreview();
    expect(result).toMatchObject({ size: 512 * LIMIT, truncated: !binary, isBinary: binary });
    expect(result.content.length).toBeLessThanOrEqual(LIMIT);
    const reader = handles.at(-1);
    expect(reader).toBeDefined();
    if (!reader) {
      throw new Error('Missing file handle');
    }
    expect(reader.readFile).not.toHaveBeenCalled();
    expect(readLengths.length).toBeGreaterThan(0);
    expect(readLengths.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(LIMIT + 1);
    expect(reader.close).toHaveBeenCalledOnce();
  });

  it.each(['é', '€', '😀'])('omits a %s codepoint cut at the byte limit', async (codepoint) => {
    await writeFile(join(rootDir, 'preview.txt'), `${'a'.repeat(LIMIT - 1)}${codepoint}tail`);
    const result = await readPreview();
    expect(result.content.length).toBe(LIMIT - 1);
    expect(result.content.endsWith('a')).toBe(true);
    expect(result.content).not.toContain('\uFFFD');
    expect(result.truncated).toBe(true);
  });

  it.each([0, LIMIT - 1, LIMIT, LIMIT + 1])('handles a file of %i bytes', async (size) => {
    await writeFile(join(rootDir, 'preview.txt'), 'a'.repeat(size));
    const result = await readPreview();
    expect(result).toMatchObject({ size, truncated: size > LIMIT, isBinary: false });
    expect(result.content.length).toBe(Math.min(size, LIMIT));
  });

  it('preserves binary detection in the first 8 KiB and the binary response contract', async () => {
    const contents = Buffer.alloc(LIMIT + 10, 'a');
    contents[8191] = 0;
    await writeFile(join(rootDir, 'preview.txt'), contents);
    expect(await readPreview()).toEqual({
      content: '[Binary file - cannot display]',
      language: 'text',
      truncated: false,
      size: LIMIT + 10,
      isBinary: true,
    });
    contents[8191] = 97;
    contents[8192] = 0;
    await writeFile(join(rootDir, 'preview.txt'), contents);
    expect(await readPreview()).toMatchObject({ isBinary: false, truncated: true });
  });

  it('assembles short reads without treating them as EOF', async () => {
    await writeFile(join(rootDir, 'preview.txt'), 'a😀éz');
    chunkSize = 2;
    expect(await readPreview()).toMatchObject({ content: 'a😀éz', size: 8, truncated: false });
  });

  it('stops at EOF if a file shrinks after stat', async () => {
    await writeFile(join(rootDir, 'preview.txt'), 'a'.repeat(100));
    replaceOnRead = 'short';
    expect(await readPreview()).toMatchObject({ content: 'short', size: 100, truncated: false });
  });

  it('caps reads and flags truncation when a file grows after stat', async () => {
    await writeFile(join(rootDir, 'preview.txt'), 'short');
    replaceOnRead = 'a'.repeat(LIMIT + 10);
    const result = await readPreview();
    expect(result).toMatchObject({ size: 5, truncated: true });
    expect(result.content.length).toBe(LIMIT);
    expect(readLengths.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(LIMIT + 1);
  });

  it('retains a complete multibyte codepoint ending exactly at the byte limit', async () => {
    await writeFile(join(rootDir, 'preview.txt'), `${'a'.repeat(LIMIT - 4)}😀`);
    const result = await readPreview();
    expect(result).toMatchObject({ size: LIMIT, truncated: false });
    expect(result.content.endsWith('😀')).toBe(true);
    expect(Buffer.byteLength(result.content)).toBe(LIMIT);
  });

  it('closes the descriptor when reading fails', async () => {
    await writeFile(join(rootDir, 'preview.txt'), 'text');
    readError = new Error('read failed');
    await expect(readPreview()).rejects.toThrow('read failed');
    expect(handles.at(-1)?.close).toHaveBeenCalledOnce();
  });

  it('rejects directories before opening a descriptor', async () => {
    await mkdir(join(rootDir, 'preview.txt'));
    await expect(readPreview()).rejects.toThrow('Path is a directory');
    expect(handles).toHaveLength(0);
  });

  it.skipIf(process.platform === 'win32').each([false, true])(
    'rejects a FIFO without waiting for a writer (replaced during open: %s)',
    async (replacedDuringOpen) => {
      const fullPath = join(rootDir, 'preview.txt');
      if (replacedDuringOpen) {
        await writeFile(fullPath, 'regular file');
        replaceWithFifoOnOpen = true;
      } else {
        execFileSync('mkfifo', [fullPath]);
      }
      // Release a regressed blocking open so a failure cannot strand a worker.
      let neededWriter = false;
      const release = setTimeout(() => {
        neededWriter = true;
        const writer = openSync(fullPath, constants.O_RDWR | constants.O_NONBLOCK);
        closeSync(writer);
      }, 1000);
      try {
        await expect(readPreview()).rejects.toThrow('Path is not a regular file');
        expect(neededWriter).toBe(false);
        expect(readLengths).toEqual([]);
        if (replacedDuringOpen) {
          expect(handles.at(-1)?.close).toHaveBeenCalledOnce();
        }
      } finally {
        clearTimeout(release);
      }
    }
  );

  it('keeps valid complete Unicode and malformed trailing bytes at EOF', async () => {
    await writeFile(
      join(rootDir, 'preview.txt'),
      Buffer.from([0xef, 0xbb, 0xbf, 0xc3, 0xa9, 0xe2])
    );
    expect(await readPreview()).toMatchObject({
      content: '\uFEFFé\uFFFD',
      truncated: false,
      size: 6,
    });
  });
});
