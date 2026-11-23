/** Minimal image headers for tests: enough bytes for `readImageHeader`, not decodable images. */

const ascii = (text: string) => Array.from(text, (character) => character.charCodeAt(0));
const u32be = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const u16be = (value: number) => [(value >>> 8) & 0xff, value & 0xff];
const u24le = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];

function pngChunk(type: string, data: number[]): number[] {
  return [...u32be(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
}

export function pngHeader(
  width: number,
  height: number,
  { animated = false, metadataBytes = 64 }: { animated?: boolean; metadataBytes?: number } = {}
): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    0x89,
    ...ascii('PNG\r\n\x1a\n'),
    ...pngChunk('IHDR', [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]),
    ...pngChunk('iCCP', new Array(metadataBytes).fill(1)),
    ...(animated ? pngChunk('acTL', [...u32be(2), ...u32be(0)]) : []),
    ...pngChunk('IDAT', [0, 0, 0, 0]),
  ]);
}

export function jpegHeader(
  width: number,
  height: number,
  { progressive = false }: { progressive?: boolean } = {}
): Uint8Array<ArrayBuffer> {
  const exif = [...ascii('Exif\0\0'), ...new Array(40).fill(0)];
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    ...u16be(16),
    ...ascii('JFIF\0'),
    ...new Array(9).fill(0),
    0xff,
    0xe1,
    ...u16be(exif.length + 2),
    ...exif,
    0xff,
    0xdb,
    ...u16be(4),
    0,
    0,
    0xff,
    progressive ? 0xc2 : 0xc0,
    ...u16be(17),
    8,
    ...u16be(height),
    ...u16be(width),
    3,
    ...new Array(9).fill(0),
  ]);
}

export function webpHeader(
  chunk: 'VP8X' | 'VP8 ' | 'VP8L',
  width: number,
  height: number,
  animated = false
): Uint8Array<ArrayBuffer> {
  let data: number[];
  if (chunk === 'VP8X') {
    data = [animated ? 0x02 : 0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)];
  } else if (chunk === 'VP8 ') {
    data = [0, 0, 0, 0x9d, 0x01, 0x2a, width & 0xff, width >> 8, height & 0xff, height >> 8];
  } else {
    // 14-bit width - 1 and height - 1, packed little-endian after the 0x2f signature.
    const bits = (width - 1) | ((height - 1) << 14);
    data = [0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff];
  }
  const body = [...ascii('WEBP'), ...ascii(chunk), data.length, 0, 0, 0, ...data];
  return new Uint8Array([...ascii('RIFF'), ...u24le(body.length), 0, ...body]);
}

export function gifHeader(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([...ascii('GIF89a'), 10, 0, 10, 0, 0, 0, 0]);
}
