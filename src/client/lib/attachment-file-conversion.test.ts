import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fileToBase64, MAX_IMAGE_SIZE, MAX_TEXT_FILE_SIZE, readTextFile } from '@/lib/image-utils';
import { collectAttachments } from './attachment-file-conversion';
import {
  DOWNSCALE_JPEG_QUALITY,
  DOWNSCALE_MAX_EDGE,
  MAX_DOWNSCALE_INPUT_SIZE,
} from './image-downscale-plan';
import { resizeImage } from './image-resize';

vi.mock('@/lib/image-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/image-utils')>()),
  fileToBase64: vi.fn().mockResolvedValue('base64'),
  readTextFile: vi.fn().mockResolvedValue('text content'),
}));
vi.mock('./image-resize', () => ({ resizeImage: vi.fn().mockResolvedValue(null) }));

const image = (name = 'shot.png', type = 'image/png') => new File(['img'], name, { type });
const text = (name = 'notes.md', type = '') => new File(['notes'], name, { type });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('attachment conversion', () => {
  it.each(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'])(
    'preserves the image envelope for %s',
    async (type) => {
      const file = image('photo.md', type);
      const result = await collectAttachments({ mode: 'images-and-text', files: [file] });
      expect(result.errors).toEqual([]);
      expect(result.attachments).toEqual([
        {
          id: expect.stringMatching(/^att-/),
          name: 'photo.md',
          type,
          size: 3,
          data: 'base64',
          contentType: 'image',
        },
      ]);
      expect(fileToBase64).toHaveBeenCalledWith(file);
      expect(readTextFile).not.toHaveBeenCalled();
    }
  );

  it.each(['', 'text/markdown', 'application/octet-stream'])(
    'accepts a case-insensitive text extension with MIME %j',
    async (type) => {
      const file = text('README.MD', type);
      const result = await collectAttachments({ mode: 'images-and-text', files: [file] });
      expect(result.attachments[0]).toEqual({
        id: expect.stringMatching(/^att-/),
        name: 'README.MD',
        type: type || 'text/plain',
        size: 5,
        data: 'text content',
        contentType: 'text',
      });
      expect(readTextFile).toHaveBeenCalledWith(file);
    }
  );

  it.each(['images-only', 'images-and-text'] as const)(
    'collects partial successes and errors in input order for %s',
    async (mode) => {
      const files = [image('first.png'), text(), image('last.png'), image('bad.exe', 'bad/type')];
      const result = await collectAttachments({ mode, files });
      expect(result.attachments.map(({ name }) => name)).toEqual(
        mode === 'images-only' ? ['first.png', 'last.png'] : ['first.png', 'notes.md', 'last.png']
      );
      expect(result.errors).toEqual(
        mode === 'images-only'
          ? [
              { fileName: 'notes.md', message: 'Unsupported file type: ' },
              { fileName: 'bad.exe', message: 'Unsupported file type: bad/type' },
            ]
          : [{ fileName: 'bad.exe', message: 'unsupported file type' }]
      );
    }
  );

  it.each([
    ['image/png', 'huge.png', MAX_IMAGE_SIZE, '10.0 MB'],
    ['text/plain', 'huge.txt', MAX_TEXT_FILE_SIZE, '1.0 MB'],
  ] as const)('validates the %s size boundary before reading', async (type, name, limit, label) => {
    const file = new File([], name, { type });
    Object.defineProperty(file, 'size', { value: limit, configurable: true });
    expect((await collectAttachments({ mode: 'images-and-text', files: [file] })).errors).toEqual(
      []
    );
    vi.clearAllMocks();
    Object.defineProperty(file, 'size', { value: limit + 1, configurable: true });
    const result = await collectAttachments({ mode: 'images-and-text', files: [file] });
    expect(result.errors[0]?.message).toBe(`File too large: ${label} (max ${label})`);
    Object.defineProperty(file, 'size', { value: 1024 ** 3 });
    const huge = await collectAttachments({ mode: 'images-and-text', files: [file] });
    expect(huge.errors[0]?.message).toBe(`File too large: 1.0 GB (max ${label})`);
    expect(fileToBase64).not.toHaveBeenCalled();
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it('keeps read error presentation and continues after non-Error failures', async () => {
    vi.mocked(fileToBase64)
      .mockRejectedValueOnce(new Error('failed read'))
      .mockRejectedValueOnce('bad');
    vi.mocked(readTextFile).mockRejectedValueOnce(new Error('disk error'));
    const result = await collectAttachments({
      mode: 'images-and-text',
      files: [image('bad.png'), image('unknown.png'), text(), image('good.png')],
    });
    expect(result.attachments.map(({ name }) => name)).toEqual(['good.png']);
    expect(result.errors).toEqual([
      { fileName: 'bad.png', message: 'failed read' },
      { fileName: 'unknown.png', message: 'Unknown error' },
      { fileName: 'notes.md', message: "Couldn't read notes.md. disk error" },
    ]);
  });

  it('reads chat selection concurrently while preserving result order', async () => {
    let finishFirst: (value: string) => void = () => undefined;
    let finishSecond: (value: string) => void = () => undefined;
    vi.mocked(fileToBase64)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSecond = resolve;
          })
      );
    const pending = collectAttachments({
      mode: 'images-only',
      files: [image('first.png'), image('second.png')],
    });
    await vi.waitFor(() => expect(fileToBase64).toHaveBeenCalledTimes(2));
    finishSecond('second');
    finishFirst('first');
    const result = await pending;
    expect(result.attachments.map(({ data }) => data)).toEqual(['first', 'second']);
  });

  it.each(['images-and-text', 'clipboard-images'] as const)(
    'keeps %s reads sequential',
    async (mode) => {
      let finish: (value: string) => void = () => undefined;
      vi.mocked(fileToBase64).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      const files = [image('first.png'), image('second.png')];
      const pending = collectAttachments(
        mode === 'clipboard-images'
          ? { mode, images: files.map((file) => ({ file, type: file.type })) }
          : { mode, files }
      );
      await vi.waitFor(() => expect(fileToBase64).toHaveBeenCalledTimes(1));
      finish('first');
      const result = await pending;
      expect(fileToBase64).toHaveBeenCalledTimes(2);
      expect(result.attachments.map(({ name }) => name)).toEqual(['first.png', 'second.png']);
    }
  );

  it('uses captured clipboard MIME and filename defaults, collecting extraction and read failures', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(123).mockReturnValueOnce(123);
    vi.mocked(fileToBase64).mockRejectedValueOnce(new Error('unreadable'));
    const result = await collectAttachments({
      mode: 'clipboard-images',
      images: [
        { file: null, type: 'image/jpeg' },
        { file: image('bad.png'), type: 'image/png' },
        { file: image('', ''), type: 'image/png' },
      ],
    });
    expect(result.errors.map(({ message }) => message)).toEqual([
      "Couldn't extract image from clipboard (image/jpeg)",
      "Couldn't read image. unreadable",
    ]);
    expect(result.attachments[0]).toMatchObject({
      name: 'pasted-image-123.png',
      type: 'image/png',
    });
    now.mockRestore();
  });

  it.each(['images-only', 'images-and-text'] as const)('handles empty %s batches', async (mode) => {
    expect(await collectAttachments({ mode, files: [] })).toEqual({ attachments: [], errors: [] });
  });
});

describe('image downscale before upload', () => {
  const sized = (file: File, size: number) => {
    Object.defineProperty(file, 'size', { value: size, configurable: true });
    return file;
  };
  const encoded = (size: number, type: string) => sized(new File(['small'], 'x', { type }), size);

  it.each([
    ['image/jpeg', 'image/jpeg'],
    ['image/jpg', 'image/jpeg'],
    ['image/png', 'image/png'],
    ['image/webp', 'image/png'],
  ])('asks for %s to be resized as %s', async (type, outputType) => {
    const file = image('photo', type);
    await collectAttachments({ mode: 'images-only', files: [file] });
    expect(resizeImage).toHaveBeenCalledWith(file, {
      maxEdge: DOWNSCALE_MAX_EDGE,
      outputType,
      quality: DOWNSCALE_JPEG_QUALITY,
    });
  });

  it.each([
    ['an animated-capable GIF', image('anim.gif', 'image/gif')],
    [
      'an input too large to decode',
      sized(image('huge.jpg', 'image/jpeg'), MAX_DOWNSCALE_INPUT_SIZE + 1),
    ],
  ])('does not decode %s', async (_label, file) => {
    await collectAttachments({ mode: 'images-only', files: [file] });
    expect(resizeImage).not.toHaveBeenCalled();
  });

  it('uploads the resized image with its own size', async () => {
    const resized = encoded(1_200_000, 'image/jpeg');
    vi.mocked(resizeImage).mockResolvedValueOnce(resized);
    vi.mocked(fileToBase64).mockResolvedValueOnce('resized-base64');
    const file = sized(image('IMG_0001.JPG', 'image/jpeg'), 4_000_000);
    const result = await collectAttachments({ mode: 'images-only', files: [file] });
    expect(fileToBase64).toHaveBeenCalledWith(resized);
    expect(result.attachments[0]).toMatchObject({
      name: 'IMG_0001.JPG',
      type: 'image/jpeg',
      size: 1_200_000,
      data: 'resized-base64',
    });
  });

  it('renames an image whose format changed', async () => {
    vi.mocked(resizeImage).mockResolvedValueOnce(encoded(10, 'image/png'));
    const file = sized(image('render.webp', 'image/webp'), 20);
    const result = await collectAttachments({ mode: 'images-only', files: [file] });
    expect(result.attachments[0]).toMatchObject({
      name: 'render.png',
      type: 'image/png',
      size: 10,
    });
  });

  it.each([
    ['is not smaller', () => Promise.resolve(encoded(100, 'image/png'))],
    ['is within the cap', () => Promise.resolve(null)],
    ['cannot be decoded', () => Promise.reject(new Error('decode failed'))],
    ['comes back in another format', () => Promise.resolve(encoded(10, 'image/webp'))],
  ])('keeps the original when the resized image %s', async (_label, resize) => {
    vi.mocked(resizeImage).mockImplementationOnce(resize);
    const file = sized(image('shot.png'), 100);
    const result = await collectAttachments({ mode: 'images-only', files: [file] });
    expect(fileToBase64).toHaveBeenCalledWith(file);
    expect(result.attachments[0]).toMatchObject({ name: 'shot.png', type: 'image/png', size: 100 });
  });

  it('accepts a large photo that downscales under the upload limit', async () => {
    vi.mocked(resizeImage).mockResolvedValueOnce(encoded(2_000_000, 'image/jpeg'));
    const file = sized(image('big.jpg', 'image/jpeg'), MAX_IMAGE_SIZE * 2);
    const result = await collectAttachments({ mode: 'images-and-text', files: [file] });
    expect(result.errors).toEqual([]);
    expect(result.attachments[0]?.size).toBe(2_000_000);
  });

  it('rejects a large image that cannot be downscaled under the limit', async () => {
    vi.mocked(resizeImage).mockResolvedValueOnce(encoded(12 * 1024 * 1024, 'image/png'));
    const file = sized(image('big.png'), MAX_IMAGE_SIZE * 2);
    const result = await collectAttachments({ mode: 'images-and-text', files: [file] });
    expect(result.errors).toEqual([
      { fileName: 'big.png', message: 'File too large: 12.0 MB (max 10.0 MB)' },
    ]);
    expect(fileToBase64).not.toHaveBeenCalled();
  });

  it('downscales pasted images before naming them', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(7);
    vi.mocked(resizeImage).mockResolvedValueOnce(encoded(10, 'image/png'));
    const file = sized(image('', 'image/webp'), 20);
    const result = await collectAttachments({
      mode: 'clipboard-images',
      images: [{ file, type: 'image/webp' }],
    });
    expect(result.attachments[0]).toMatchObject({
      name: 'pasted-image-7.png',
      type: 'image/png',
      size: 10,
    });
    now.mockRestore();
  });
});
