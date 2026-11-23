// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resizeImage } from './image-resize';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: unknown[] = [];
  terminate = vi.fn();

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(data: unknown) {
    this.posted.push(data);
  }

  reply(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
}

const request = { maxEdge: 2576, outputType: 'image/jpeg', quality: 0.85 } as const;
const photo = () => new File(['jpeg'], 'photo.jpg', { type: 'image/jpeg' });

function stubMainThreadCanvas(width: number, height: number) {
  const bitmap = { width, height, close: vi.fn() };
  const decode = vi.fn().mockResolvedValue(bitmap);
  vi.stubGlobal('createImageBitmap', decode);
  const context = { drawImage: vi.fn(), imageSmoothingEnabled: false, imageSmoothingQuality: '' };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D
  );
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback,
    type
  ) {
    callback(new Blob([`${this.width}x${this.height}`], { type }));
  });
  return { bitmap, decode, context, toBlob };
}

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function nextWorker(index = 0): Promise<FakeWorker> {
  await vi.waitFor(() => expect(FakeWorker.instances[index]).toBeDefined());
  return FakeWorker.instances[index] as FakeWorker;
}

describe('resizeImage', () => {
  it('resizes in a worker and terminates it', async () => {
    const file = photo();
    const pending = resizeImage(file, request);
    const worker = await nextWorker();
    expect(worker.posted).toEqual([{ file, ...request }]);
    const resized = new Blob(['small'], { type: 'image/jpeg' });
    worker.reply({ status: 'resized', blob: resized });
    await expect(pending).resolves.toBe(resized);
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('resolves null when the worker finds the image within the cap', async () => {
    const pending = resizeImage(photo(), request);
    (await nextWorker()).reply({ status: 'unchanged' });
    await expect(pending).resolves.toBeNull();
  });

  it.each([
    [{ status: 'failed', message: 'decode failed' }, 'decode failed'],
    [{ status: 'resized', blob: 'not a blob' }, 'Unexpected image resize response'],
  ])('rejects a worker failure %j', async (reply, message) => {
    const pending = resizeImage(photo(), request);
    (await nextWorker()).reply(reply);
    await expect(pending).rejects.toThrow(message);
  });

  it('gives up on a stuck worker so later images are not blocked', async () => {
    vi.useFakeTimers();
    const pending = resizeImage(photo(), request);
    const rejection = expect(pending).rejects.toThrow('Image resize timed out');
    const worker = await nextWorker();
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('resizes one image at a time', async () => {
    const first = resizeImage(photo(), request);
    const second = resizeImage(photo(), request);
    const firstWorker = await nextWorker();
    await Promise.resolve();
    expect(FakeWorker.instances).toHaveLength(1);
    firstWorker.reply({ status: 'failed', message: 'bad' });
    await expect(first).rejects.toThrow('bad');
    (await nextWorker(1)).reply({ status: 'unchanged' });
    await expect(second).resolves.toBeNull();
  });

  it.each([
    ['reports no OffscreenCanvas', (worker: FakeWorker) => worker.reply({ status: 'unsupported' })],
    ['fails to load', (worker: FakeWorker) => worker.onerror?.()],
  ])('falls back to the main thread when the worker %s', async (_label, fail) => {
    const { bitmap, decode, context, toBlob } = stubMainThreadCanvas(5000, 2500);
    const file = photo();
    const pending = resizeImage(file, request);
    fail(await nextWorker());
    const resized = await pending;
    expect(decode).toHaveBeenCalledWith(file, { imageOrientation: 'from-image' });
    expect(context.imageSmoothingQuality).toBe('high');
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 2576, 1288);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.85);
    expect(await resized?.text()).toBe('2576x1288');
    expect(bitmap.close).toHaveBeenCalled();
  });

  it('resizes on the main thread without workers, leaving images within the cap alone', async () => {
    vi.stubGlobal('Worker', undefined);
    const { bitmap, context } = stubMainThreadCanvas(2576, 1000);
    await expect(resizeImage(photo(), request)).resolves.toBeNull();
    expect(context.drawImage).not.toHaveBeenCalled();
    expect(bitmap.close).toHaveBeenCalled();
  });

  it('decodes without the orientation option where the engine rejects it', async () => {
    vi.stubGlobal('Worker', undefined);
    const { decode } = stubMainThreadCanvas(4000, 3000);
    decode.mockRejectedValueOnce(new TypeError('bad enum'));
    const file = photo();
    await expect(resizeImage(file, request)).resolves.toBeInstanceOf(Blob);
    expect(decode).toHaveBeenLastCalledWith(file);
  });

  it('rejects when the main thread cannot decode images', async () => {
    vi.stubGlobal('Worker', undefined);
    vi.stubGlobal('createImageBitmap', undefined);
    await expect(resizeImage(photo(), request)).rejects.toThrow('Image decoding unavailable');
  });
});
