import { mkdtemp, mkdir, open, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const workspace = vi.hoisted(() => vi.fn());
vi.mock('./workspace-helpers', () => ({ getWorkspaceWithWorktreeOrThrow: workspace }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
import { workspaceChatImagesRouter } from './chat-images.trpc';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
);
const caller = workspaceChatImagesRouter.createCaller({ appContext: { services: {} } } as never);
let root: string;
beforeEach(async () => {
  vi.mocked(open).mockReset();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockImplementation(actual.open);
  root = await mkdtemp(path.join(tmpdir(), 'chat-images-'));
  await mkdir(path.join(root, 'workspace'));
  workspace.mockResolvedValue({ worktreePath: path.join(root, 'workspace') });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('chat image loading', () => {
  it('rejects a parent directory swapped to a symlink before opening', async () => {
    const directory = path.join(root, 'workspace', 'previews');
    await mkdir(directory);
    await writeFile(path.join(directory, 'app-192.png'), png);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      await rename(directory, `${directory}-old`);
      await symlink(path.resolve('public/icons'), directory);
      return actual.open(...args);
    });
    await expect(
      caller.readChatImage({ workspaceId: 'w1', path: 'previews/app-192.png' })
    ).rejects.toThrow();
  });
  it('rejects a symlink swapped in after validation and before opening', async () => {
    const target = path.join(root, 'workspace', 'mockup.png');
    await writeFile(target, png);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      await rm(target);
      await symlink(path.resolve('public/icons/app-192.png'), target);
      return actual.open(...args);
    });
    await expect(caller.readChatImage({ workspaceId: 'w1', path: 'mockup.png' })).rejects.toThrow();
  });
  it.skipIf(process.platform === 'win32')(
    'supports /tmp and its physical path on macOS',
    async () => {
      const temporary = await mkdtemp('/tmp/chat-image-alias-');
      try {
        await writeFile(path.join(temporary, 'mockup.png'), png);
        for (const file of [
          path.join(temporary, 'mockup.png'),
          await realpath(path.join(temporary, 'mockup.png')),
        ]) {
          expect(await caller.readChatImage({ workspaceId: 'w1', path: file })).toMatchObject({
            mimeType: 'image/png',
            data: png.toString('base64'),
          });
        }
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  );
  it.each(['mockup.png', 'absolute', 'temporary'])(
    'loads %s images through the workspace query',
    async (kind) => {
      const file = path.join(root, kind === 'temporary' ? '' : 'workspace', 'mockup.png');
      await writeFile(file, png);
      const result = await caller.readChatImage({
        workspaceId: 'w1',
        path: kind === 'mockup.png' ? kind : file,
      });
      expect(result).toEqual({
        data: png.toString('base64'),
        mimeType: 'image/png',
        name: 'mockup.png',
      });
    }
  );

  it('rejects relative traversal even when it points into temporary storage', async () => {
    await writeFile(path.join(root, 'outside.png'), png);
    await expect(
      caller.readChatImage({ workspaceId: 'w1', path: '../outside.png' })
    ).rejects.toThrow('Invalid image path');
  });

  it.each(['missing.png', 'folder.png', 'fake.png', 'vector.svg', 'huge.png'])(
    'rejects unavailable or unsupported %s',
    async (name) => {
      const target = path.join(root, 'workspace', name);
      if (name === 'folder.png') {
        await mkdir(target);
      } else if (name === 'fake.png') {
        await writeFile(target, '<html>private data</html>');
      } else if (name === 'vector.svg') {
        await writeFile(target, '<svg/>');
      } else if (name === 'huge.png') {
        await writeFile(target, Buffer.alloc(10 * 1024 * 1024 + 1));
      }
      await expect(caller.readChatImage({ workspaceId: 'w1', path: name })).rejects.toThrow();
    }
  );

  it('rejects absolute files and symlinks outside the permitted roots', async () => {
    await symlink('/etc/hosts', path.join(root, 'workspace', 'escape.png'));
    for (const file of ['/etc/hosts', 'escape.png']) {
      await expect(caller.readChatImage({ workspaceId: 'w1', path: file })).rejects.toThrow(
        'Invalid image path'
      );
    }
  });
});
