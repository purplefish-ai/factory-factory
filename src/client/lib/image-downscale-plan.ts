/**
 * Decisions for shrinking an image attachment before upload. Pure, so the
 * worker and the main-thread fallback share them.
 *
 * - Cap: Claude 4.7 and later downscale anything over 2576 px on the long edge
 *   (or about 3.75 megapixels), older Claude models anything over 1568 px, and
 *   OpenAI's `high` detail fits images within 2048 px. Only OpenAI's `original`
 *   detail would read more, which is not worth a phone upload.
 * - Format: JPEG stays JPEG (photos, no alpha). PNG stays PNG so screenshot
 *   text is not blurred by lossy encoding and transparency survives. WebP
 *   becomes PNG for the same reasons and because Safari cannot encode WebP.
 *   GIF is left alone: it may be animated and re-encoding would keep only the
 *   first frame.
 * - The original is kept whenever re-encoding does not make it smaller.
 */

/** Longest edge, in pixels, an uploaded image is resized to. */
export const DOWNSCALE_MAX_EDGE = 2576;

/** Quality for lossy (JPEG) re-encoding. */
export const DOWNSCALE_JPEG_QUALITY = 0.85;

/**
 * Larger inputs are not decoded, so they cannot exhaust a phone tab's memory;
 * they go through the upload limit unchanged.
 */
export const MAX_DOWNSCALE_INPUT_SIZE = 50 * 1024 * 1024;

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
export function downscaleOutputType(type: string): DownscaleOutputType | null {
  return OUTPUT_TYPES[type] ?? null;
}

/**
 * Target size for an image of these (orientation-corrected) dimensions, or
 * null when its longest edge is already within the cap.
 */
export function downscaleDimensions(
  width: number,
  height: number,
  maxEdge: number = DOWNSCALE_MAX_EDGE
): { width: number; height: number } | null {
  if (!(width > 0 && height > 0)) {
    return null;
  }
  const longest = Math.max(width, height);
  if (longest <= maxEdge) {
    return null;
  }
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
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
