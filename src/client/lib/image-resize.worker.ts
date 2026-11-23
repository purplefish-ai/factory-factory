import {
  type ResizeResponse,
  type ResizeSurface,
  resizeOnSurface,
  resizeRequestSchema,
} from './image-resize-core';

function offscreenSurface(width: number, height: number): ResizeSurface {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('2D canvas unavailable');
  }
  return { context, encode: (type, quality) => canvas.convertToBlob({ type, quality }) };
}

// Safari before 16.4 has no OffscreenCanvas 2D context in workers.
function supportsOffscreenResize(): boolean {
  return (
    typeof createImageBitmap === 'function' &&
    typeof OffscreenCanvas === 'function' &&
    new OffscreenCanvas(1, 1).getContext('2d') !== null
  );
}

async function handle(data: unknown): Promise<ResizeResponse> {
  const request = resizeRequestSchema.safeParse(data);
  if (!request.success) {
    return { status: 'failed', message: 'Invalid resize request' };
  }
  if (!supportsOffscreenResize()) {
    return { status: 'unsupported' };
  }
  const { file, ...options } = request.data;
  try {
    const blob = await resizeOnSurface(file, options, offscreenSurface);
    return blob ? { status: 'resized', blob } : { status: 'unchanged' };
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

self.onmessage = (event: MessageEvent<unknown>) => {
  void handle(event.data).then((response) => self.postMessage(response));
};
