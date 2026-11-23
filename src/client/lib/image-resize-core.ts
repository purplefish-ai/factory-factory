/** Resize protocol and drawing shared by the resize worker and its main-thread fallback. */
import { z } from 'zod';
import { downscaleDimensions } from './image-downscale-plan';

export const resizeRequestSchema = z.object({
  file: z.instanceof(Blob),
  maxEdge: z.number().int().positive(),
  outputType: z.enum(['image/jpeg', 'image/png']),
  quality: z.number().min(0).max(1),
});

export type ResizeRequest = Omit<z.infer<typeof resizeRequestSchema>, 'file'>;

export const resizeResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('resized'), blob: z.instanceof(Blob) }),
  z.object({ status: z.literal('unchanged') }),
  z.object({ status: z.literal('unsupported') }),
  z.object({ status: z.literal('failed'), message: z.string() }),
]);

export type ResizeResponse = z.infer<typeof resizeResponseSchema>;

export interface ResizeSurface {
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  encode(type: string, quality: number): Promise<Blob>;
}

/** Decodes with EXIF orientation applied, so a resized photo stays upright. */
async function decodeOriented(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (error) {
    // Engines that predate the 'from-image' value reject it as a TypeError.
    if (error instanceof TypeError) {
      return await createImageBitmap(file);
    }
    throw error;
  }
}

/**
 * Resizes `file` to fit `request.maxEdge` and encodes it, or returns null when
 * it already fits. Throws when the image cannot be decoded or encoded.
 */
export async function resizeOnSurface(
  file: Blob,
  request: ResizeRequest,
  createSurface: (width: number, height: number) => ResizeSurface
): Promise<Blob | null> {
  const bitmap = await decodeOriented(file);
  try {
    const target = downscaleDimensions(bitmap.width, bitmap.height, request.maxEdge);
    if (!target) {
      return null;
    }
    const surface = createSurface(target.width, target.height);
    surface.context.imageSmoothingEnabled = true;
    surface.context.imageSmoothingQuality = 'high';
    surface.context.drawImage(bitmap, 0, 0, target.width, target.height);
    return await surface.encode(request.outputType, request.quality);
  } finally {
    bitmap.close();
  }
}
