import { randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * A valid RGB PNG of random pixels. Noise does not compress, so a 590 x 590
 * image is just over 1 MB, the size the bandwidth measurements use.
 */
export function noisePng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    rows.push(Buffer.concat([Buffer.from([0]), randomBytes(width * 3)]));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The first bytes of a baseline JPEG: SOI, a JFIF APP0 and an SOF0 frame header. */
export function jpegHeader(width: number, height: number, options?: { exif?: boolean }): Buffer {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
    0x00, 0x00,
  ]);
  const exif = options?.exif
    ? Buffer.from([0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00])
    : Buffer.alloc(0);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, exif, sof, Buffer.alloc(16)]);
}

/** The first bytes of a GIF89a. */
export function gifHeader(width: number, height: number): Buffer {
  const header = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(7)]);
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  return header;
}

/** The first bytes of an extended-format (VP8X) WebP. */
export function webpHeader(width: number, height: number): Buffer {
  const header = Buffer.concat([
    Buffer.from('RIFF\0\0\0\0WEBPVP8X', 'ascii'),
    Buffer.from([10, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.alloc(6),
  ]);
  header.writeUIntLE(width - 1, 24, 3);
  header.writeUIntLE(height - 1, 27, 3);
  return header;
}
