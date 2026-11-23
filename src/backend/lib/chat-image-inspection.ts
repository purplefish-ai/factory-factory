import type { ChatImageMediaType } from '@/shared/chat-image-ref';

export interface InspectedChatImage {
  /** Read from the bytes, never from a declared type. */
  mediaType: ChatImageMediaType;
  /** Decoded size in bytes. */
  size: number;
  width?: number;
  height?: number;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Enough base64 for every header read here, including a JPEG's early segments. */
const PREFIX_CHARS = 64 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_START_OF_FRAME = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const JPEG_APP1 = 0xe1;
const JPEG_START_OF_SCAN = 0xda;

type Dimensions = { width: number; height: number } | null;

function dimensions(width: number, height: number): Dimensions {
  return width > 0 && height > 0 ? { width, height } : null;
}

function pngDimensions(bytes: Buffer): Dimensions {
  if (bytes.length < 24 || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') {
    return null;
  }
  return dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
}

function webpDimensions(bytes: Buffer): Dimensions {
  const chunk = bytes.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return dimensions(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1);
  }
  if (chunk === 'VP8 ' && bytes.length >= 30) {
    return dimensions(bytes.readUInt16LE(26) & 0x3f_ff, bytes.readUInt16LE(28) & 0x3f_ff);
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return dimensions((bits & 0x3f_ff) + 1, ((bits >>> 14) & 0x3f_ff) + 1);
  }
  return null;
}

/**
 * The frame size from a JPEG's SOF segment. An Exif segment may carry an
 * orientation that swaps the rendered width and height, so none is reported.
 */
function jpegDimensions(bytes: Buffer): Dimensions {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return null;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === JPEG_APP1 || marker === JPEG_START_OF_SCAN) {
      return null;
    }
    if (JPEG_START_OF_FRAME.has(marker)) {
      return dimensions(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5));
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return null;
}

function sniff(bytes: Buffer): { mediaType: ChatImageMediaType; dimensions: Dimensions } | null {
  if (bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { mediaType: 'image/png', dimensions: pngDimensions(bytes) };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mediaType: 'image/jpeg', dimensions: jpegDimensions(bytes) };
  }
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) {
    return {
      mediaType: 'image/gif',
      dimensions: dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8)),
    };
  }
  if (
    bytes.length >= 16 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mediaType: 'image/webp', dimensions: webpDimensions(bytes) };
  }
  return null;
}

/**
 * What the chat image endpoint may serve for some base64 bytes: a supported
 * raster type read from the bytes themselves, the decoded size and, when its
 * header gives them cheaply, the dimensions. Anything else (SVG, HTML, text,
 * malformed base64) returns null and stays inline.
 */
export function inspectChatImage(data: string): InspectedChatImage | null {
  if (data.length === 0 || data.length % 4 !== 0 || !BASE64.test(data)) {
    return null;
  }
  const sniffed = sniff(Buffer.from(data.slice(0, PREFIX_CHARS), 'base64'));
  if (!sniffed) {
    return null;
  }
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return {
    mediaType: sniffed.mediaType,
    size: (data.length / 4) * 3 - padding,
    ...(sniffed.dimensions ?? {}),
  };
}
