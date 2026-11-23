import type { ImageHeader } from './image-header';

/**
 * Decisions for shrinking an image attachment before upload. Pure, so the
 * worker and the main-thread fallback share them.
 *
 * - Cap: Claude 4.7 and later downscale anything over 2576 px on the long edge
 *   or 4,784 visual tokens of 28 x 28 px (about 3.75 megapixels), older Claude
 *   models anything over 1568 px, and OpenAI's `high` detail fits images within
 *   2048 px and 2,500 patches of 32 x 32 px. Only OpenAI's `original` detail
 *   would read more, which is not worth a phone upload.
 * - Format: JPEG stays JPEG (photos, no alpha). PNG stays PNG so screenshot
 *   text is not blurred by lossy encoding and transparency survives. WebP
 *   becomes PNG for the same reasons and because Safari cannot encode WebP.
 *   GIFs and animated PNG and WebP are left alone: re-encoding would keep only
 *   the first frame.
 * - Images are not decoded unless their header shows they exceed the cap, and
 *   never when they are so large that decoding could exhaust a phone tab.
 * - The original is kept whenever re-encoding does not make it smaller.
 */

export interface DownscaleLimits {
  maxEdge: number;
  maxPixels: number;
}

export const DOWNSCALE_LIMITS: DownscaleLimits = {
  maxEdge: 2576,
  maxPixels: 4784 * 28 * 28,
};

/** Quality for lossy (JPEG) re-encoding. */
export const DOWNSCALE_JPEG_QUALITY = 0.85;

/** Above this the image is not decoded (4 bytes a pixel); 48 MP phone photos still are. */
export const MAX_DECODE_PIXELS = 50_000_000;

export type DownscaleOutputType = 'image/jpeg' | 'image/png';

const OUTPUT_TYPES: Readonly<Record<string, DownscaleOutputType>> = {
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/png',
};

const EXTENSIONS: Readonly<Record<DownscaleOutputType, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/** The encoding a resized image of this type uses, or null to leave it alone. */
function downscaleOutputType(type: string): DownscaleOutputType | null {
  return OUTPUT_TYPES[type] ?? null;
}

/**
 * Target size for an image of these (orientation-corrected) dimensions, or
 * null when it is already within the limits.
 */
export function downscaleDimensions(
  width: number,
  height: number,
  limits: DownscaleLimits = DOWNSCALE_LIMITS
): { width: number; height: number } | null {
  if (!(width > 0 && height > 0)) {
    return null;
  }
  const scale = Math.min(
    limits.maxEdge / Math.max(width, height),
    Math.sqrt(limits.maxPixels / (width * height))
  );
  if (scale >= 1) {
    return null;
  }
  // The epsilon keeps floating-point error from losing a pixel on an exact fit.
  const scaled = (edge: number) => Math.max(1, Math.floor(edge * scale + 1e-9));
  return { width: scaled(width), height: scaled(height) };
}

/**
 * The format to re-encode an image to, or null to upload it unchanged because
 * its type is left alone, its header is unreadable, it is animated, it already
 * fits, or it is too large to decode safely.
 */
export function planDownscale(
  type: string,
  header: ImageHeader | null
): DownscaleOutputType | null {
  const outputType = downscaleOutputType(type);
  if (!(outputType && header) || header.animated) {
    return null;
  }
  if (header.width * header.height > MAX_DECODE_PIXELS) {
    return null;
  }
  return downscaleDimensions(header.width, header.height) ? outputType : null;
}

export function keepsOriginal(originalSize: number, encodedSize: number): boolean {
  return encodedSize >= originalSize;
}

/** The file name for an image re-encoded from `fromType` to `toType`. */
export function nameForType(name: string, fromType: string, toType: DownscaleOutputType): string {
  if ((fromType === 'image/jpg' ? 'image/jpeg' : fromType) === toType) {
    return name;
  }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base}.${EXTENSIONS[toType]}`;
}
