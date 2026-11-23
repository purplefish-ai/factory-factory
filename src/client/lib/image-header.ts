/**
 * Reads an image's stored dimensions, and whether it is animated, from its
 * first bytes, so the uploader can decide whether to decode it at all.
 * JPEG dimensions are before EXIF orientation; callers only compare edges and
 * areas, which rotation does not change.
 */

export interface ImageHeader {
  width: number;
  height: number;
  animated: boolean;
}

/** Enough to reach the frame header past typical EXIF, ICC and XMP metadata. */
export const IMAGE_HEADER_BYTES = 512 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  return prefix.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function u32be(bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(offset);
}

function u16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function readPng(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== 'IHDR') {
    return null;
  }
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  // An APNG's acTL chunk precedes the first IDAT. If the bytes end before
  // IDAT, assume animation rather than flatten one.
  let animated = true;
  for (let offset = 8; offset + 8 <= bytes.length;) {
    const type = ascii(bytes, offset + 4, 4);
    if (type === 'acTL') {
      break;
    }
    if (type === 'IDAT') {
      animated = false;
      break;
    }
    offset += 12 + u32be(bytes, offset);
  }
  return { width, height, animated };
}

// SOF0-SOF15 except DHT (C4), JPG (C8) and DAC (CC).
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function readJpeg(bytes: Uint8Array): ImageHeader | null {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      return null;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (isStartOfFrame(marker)) {
      if (offset + 9 > bytes.length) {
        return null;
      }
      return { width: u16be(bytes, offset + 7), height: u16be(bytes, offset + 5), animated: false };
    }
    offset += 2 + u16be(bytes, offset + 2);
  }
  return null;
}

function readWebp(bytes: Uint8Array): ImageHeader | null {
  const chunk = ascii(bytes, 12, 4);
  if (bytes.length < (chunk === 'VP8L' ? 25 : 30)) {
    return null;
  }
  switch (chunk) {
    case 'VP8X':
      return {
        width: u24le(bytes, 24) + 1,
        height: u24le(bytes, 27) + 1,
        animated: ((bytes[20] ?? 0) & 0x02) !== 0,
      };
    case 'VP8 ':
      // The key frame start code precedes 14-bit dimensions.
      if (!startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) {
        return null;
      }
      return {
        width: u24le(bytes, 26) & 0x3f_ff,
        height: u24le(bytes, 28) & 0x3f_ff,
        animated: false,
      };
    case 'VP8L': {
      const bits = u24le(bytes, 21) | ((bytes[24] ?? 0) << 24);
      return {
        width: (bits & 0x3f_ff) + 1,
        height: ((bits >>> 14) & 0x3f_ff) + 1,
        animated: false,
      };
    }
    default:
      return null;
  }
}

/** Dimensions of a PNG, JPEG or WebP image, or null for anything else or too few bytes. */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return readPng(bytes);
  }
  if (startsWith(bytes, [0xff, 0xd8])) {
    return readJpeg(bytes);
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return readWebp(bytes);
  }
  return null;
}
