import {
  type ResizeRequest,
  type ResizeSurface,
  resizeOnSurface,
  resizeResponseSchema,
} from './image-resize-core';

const UNSUPPORTED = Symbol('unsupported');

/** A stuck decode must not block later attachments; the caller keeps the original. */
const WORKER_TIMEOUT_MS = 30_000;

let queue: Promise<unknown> = Promise.resolve();

/**
 * Resizes an image whose longest edge exceeds `request.maxEdge` and encodes it
 * as `request.outputType`; resolves null when it already fits and rejects when
 * it cannot be decoded. Runs in a worker with OffscreenCanvas where the browser
 * has one, otherwise on the main thread. Images are resized one at a time so a
 * multi-photo selection does not hold several decoded photos in a phone's
 * memory at once.
 */
export function resizeImage(file: Blob, request: ResizeRequest): Promise<Blob | null> {
  const result = queue.then(async () => {
    const outcome = await resizeInWorker(file, request);
    return outcome === UNSUPPORTED ? await resizeOnMainThread(file, request) : outcome;
  });
  queue = result.catch(() => undefined);
  return result;
}

function resizeInWorker(
  file: Blob,
  request: ResizeRequest
): Promise<Blob | null | typeof UNSUPPORTED> {
  if (typeof Worker === 'undefined') {
    return Promise.resolve(UNSUPPORTED);
  }
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./image-resize.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      resolve(UNSUPPORTED);
      return;
    }
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error('Image resize timed out'));
    }, WORKER_TIMEOUT_MS);
    const stop = () => {
      clearTimeout(timeout);
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<unknown>) => {
      stop();
      const response = resizeResponseSchema.safeParse(event.data);
      if (!response.success) {
        reject(new Error('Unexpected image resize response'));
        return;
      }
      switch (response.data.status) {
        case 'resized':
          resolve(response.data.blob);
          return;
        case 'unchanged':
          resolve(null);
          return;
        case 'unsupported':
          resolve(UNSUPPORTED);
          return;
        case 'failed':
          reject(new Error(response.data.message));
          return;
      }
    };
    // The worker script failed to load, for example without module workers.
    worker.onerror = () => {
      stop();
      resolve(UNSUPPORTED);
    };
    worker.onmessageerror = () => {
      stop();
      reject(new Error('Unreadable image resize response'));
    };
    worker.postMessage({ file, ...request });
  });
}

function elementSurface(width: number, height: number): ResizeSurface {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('2D canvas unavailable');
  }
  return {
    context,
    encode: (type, quality) =>
      new Promise((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('Canvas encoding failed'))),
          type,
          quality
        );
      }),
  };
}

function resizeOnMainThread(file: Blob, request: ResizeRequest): Promise<Blob | null> {
  if (typeof createImageBitmap !== 'function') {
    return Promise.reject(new Error('Image decoding unavailable'));
  }
  return resizeOnSurface(file, request, elementSurface);
}
