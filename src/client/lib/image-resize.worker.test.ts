// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import './image-resize.worker';

const request = {
  file: new File(['png'], 'shot.png', { type: 'image/png' }),
  maxEdge: 2576,
  maxPixels: 3_750_656,
  outputType: 'image/png',
  quality: 0.85,
};

function stubOffscreen(width: number, height: number) {
  const bitmap = { width, height, close: vi.fn() };
  const decode = vi.fn().mockResolvedValue(bitmap);
  vi.stubGlobal('createImageBitmap', decode);
  const context = { drawImage: vi.fn(), imageSmoothingEnabled: false, imageSmoothingQuality: '' };
  const convertToBlob = vi.fn(
    (options: { type: string }) => new Blob(['encoded'], { type: options.type })
  );
  const canvases: { width: number; height: number }[] = [];
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor(
        readonly width: number,
        readonly height: number
      ) {
        canvases.push({ width, height });
      }
      getContext() {
        return context;
      }
      convertToBlob = convertToBlob;
    }
  );
  return { bitmap, decode, context, convertToBlob, canvases };
}

async function send(data: unknown): Promise<unknown> {
  const post = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
  window.dispatchEvent(new MessageEvent('message', { data }));
  await vi.waitFor(() => expect(post).toHaveBeenCalled());
  return post.mock.calls[0]?.[0];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('image resize worker', () => {
  it('draws the oriented image at the capped size and encodes the requested type', async () => {
    const { bitmap, decode, context, convertToBlob, canvases } = stubOffscreen(5120, 2880);
    const response = await send(request);
    expect(decode).toHaveBeenCalledWith(request.file, { imageOrientation: 'from-image' });
    expect(canvases.at(-1)).toEqual({ width: 2576, height: 1449 });
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 2576, 1449);
    expect(convertToBlob).toHaveBeenCalledWith({ type: 'image/png', quality: 0.85 });
    expect(response).toEqual({ status: 'resized', blob: expect.any(Blob) });
    expect(bitmap.close).toHaveBeenCalled();
  });

  it('reports an image within the cap as unchanged', async () => {
    const { context } = stubOffscreen(1290, 2576);
    expect(await send(request)).toEqual({ status: 'unchanged' });
    expect(context.drawImage).not.toHaveBeenCalled();
  });

  it('reports a decode failure', async () => {
    const { decode } = stubOffscreen(1, 1);
    decode.mockRejectedValueOnce(new DOMException('The source image cannot be decoded.'));
    expect(await send(request)).toEqual({
      status: 'failed',
      message: 'The source image cannot be decoded.',
    });
  });

  it('asks for the main-thread fallback without OffscreenCanvas', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn());
    vi.stubGlobal('OffscreenCanvas', undefined);
    expect(await send(request)).toEqual({ status: 'unsupported' });
  });

  it('asks for the main-thread fallback when OffscreenCanvas has no 2D context', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn());
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return null;
        }
      }
    );
    expect(await send(request)).toEqual({ status: 'unsupported' });
  });

  it('rejects a malformed request', async () => {
    expect(await send({ ...request, outputType: 'image/gif' })).toEqual({
      status: 'failed',
      message: 'Invalid resize request',
    });
  });
});
