import { crc32 } from 'node:zlib';

export type SupportedImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface ImageFormatInspection {
  mediaType: SupportedImageMediaType;
  isValid: boolean;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function startsWith(bytes: Buffer, signature: Buffer): boolean {
  return bytes.length >= signature.length && bytes.subarray(0, signature.length).equals(signature);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: PNG chunk validation is a linear format state machine.
function isValidPng(bytes: Buffer): boolean {
  let cursor = PNG_SIGNATURE.length;
  let sawHeader = false;
  let sawImageData = false;
  let imageDataEnded = false;

  while (cursor < bytes.length) {
    if (bytes.length - cursor < 12) {
      return false;
    }

    const dataLength = bytes.readUInt32BE(cursor);
    if (dataLength > bytes.length - cursor - 12) {
      return false;
    }

    const typeStart = cursor + 4;
    const dataStart = typeStart + 4;
    const dataEnd = dataStart + dataLength;
    const chunkEnd = dataEnd + 4;
    const chunkType = bytes.subarray(typeStart, dataStart).toString('ascii');
    const expectedCrc = bytes.readUInt32BE(dataEnd);
    const actualCrc = crc32(bytes.subarray(typeStart, dataEnd));
    if (actualCrc !== expectedCrc) {
      return false;
    }

    if (!sawHeader) {
      if (chunkType !== 'IHDR' || dataLength !== 13) {
        return false;
      }

      const width = bytes.readUInt32BE(dataStart);
      const height = bytes.readUInt32BE(dataStart + 4);
      const compressionMethod = bytes.readUInt8(dataStart + 10);
      const filterMethod = bytes.readUInt8(dataStart + 11);
      const interlaceMethod = bytes.readUInt8(dataStart + 12);
      if (
        width === 0 ||
        height === 0 ||
        compressionMethod !== 0 ||
        filterMethod !== 0 ||
        (interlaceMethod !== 0 && interlaceMethod !== 1)
      ) {
        return false;
      }
      sawHeader = true;
    } else if (chunkType === 'IHDR') {
      return false;
    }

    if (chunkType === 'IDAT') {
      if (imageDataEnded) {
        return false;
      }
      sawImageData = true;
    } else if (sawImageData) {
      imageDataEnded = true;
    }

    if (chunkType === 'IEND') {
      return dataLength === 0 && sawImageData && chunkEnd === bytes.length;
    }

    cursor = chunkEnd;
  }

  return false;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: JPEG marker validation is a linear format state machine.
function isValidJpeg(bytes: Buffer): boolean {
  let cursor = 2;
  let pendingMarker: number | null = null;
  let sawFrame = false;
  let sawScan = false;

  while (cursor < bytes.length || pendingMarker !== null) {
    let marker: number;
    if (pendingMarker === null) {
      if (bytes.readUInt8(cursor) !== 0xff) {
        return false;
      }
      while (cursor < bytes.length && bytes.readUInt8(cursor) === 0xff) {
        cursor += 1;
      }
      if (cursor === bytes.length || bytes.readUInt8(cursor) === 0x00) {
        return false;
      }
      marker = bytes.readUInt8(cursor);
      cursor += 1;
    } else {
      marker = pendingMarker;
      pendingMarker = null;
    }

    if (marker === 0xd9) {
      return sawFrame && sawScan && cursor === bytes.length;
    }

    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      return false;
    }

    if (bytes.length - cursor < 2) {
      return false;
    }
    const segmentLength = bytes.readUInt16BE(cursor);
    if (segmentLength < 2 || segmentLength > bytes.length - cursor) {
      return false;
    }
    const segmentEnd = cursor + segmentLength;

    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 11) {
        return false;
      }
      const height = bytes.readUInt16BE(cursor + 3);
      const width = bytes.readUInt16BE(cursor + 5);
      const componentCount = bytes.readUInt8(cursor + 7);
      if (
        width === 0 ||
        height === 0 ||
        componentCount === 0 ||
        segmentLength !== 8 + 3 * componentCount
      ) {
        return false;
      }
      sawFrame = true;
    }

    if (marker !== 0xda) {
      cursor = segmentEnd;
      continue;
    }

    const componentCount = bytes.readUInt8(cursor + 2);
    if (componentCount === 0 || segmentLength !== 6 + 2 * componentCount) {
      return false;
    }
    sawScan = true;
    cursor = segmentEnd;

    let sawEntropyData = false;
    while (cursor < bytes.length) {
      if (bytes.readUInt8(cursor) !== 0xff) {
        sawEntropyData = true;
        cursor += 1;
        continue;
      }

      while (cursor < bytes.length && bytes.readUInt8(cursor) === 0xff) {
        cursor += 1;
      }
      if (cursor === bytes.length) {
        return false;
      }

      const scanMarker = bytes.readUInt8(cursor);
      cursor += 1;
      if (scanMarker === 0x00) {
        sawEntropyData = true;
        continue;
      }
      if (scanMarker >= 0xd0 && scanMarker <= 0xd7) {
        continue;
      }

      pendingMarker = scanMarker;
      break;
    }

    if (!sawEntropyData || pendingMarker === null) {
      return false;
    }
  }

  return false;
}

function skipGifSubBlocks(bytes: Buffer, start: number): number | null {
  let cursor = start;
  while (cursor < bytes.length) {
    const blockLength = bytes.readUInt8(cursor);
    cursor += 1;
    if (blockLength === 0) {
      return cursor;
    }
    if (blockLength > bytes.length - cursor) {
      return null;
    }
    cursor += blockLength;
  }
  return null;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: GIF block validation is a linear format state machine.
function isValidGif(bytes: Buffer): boolean {
  if (bytes.length < 14) {
    return false;
  }

  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  if (width === 0 || height === 0) {
    return false;
  }

  const logicalScreenPacked = bytes.readUInt8(10);
  const hasGlobalColorTable = (logicalScreenPacked & 0x80) !== 0;
  const globalColorTableLength = hasGlobalColorTable
    ? 3 * 2 ** ((logicalScreenPacked & 0x07) + 1)
    : 0;
  let cursor = 13 + globalColorTableLength;
  if (cursor > bytes.length) {
    return false;
  }

  let sawImage = false;
  while (cursor < bytes.length) {
    const introducer = bytes.readUInt8(cursor);
    if (introducer === 0x3b) {
      return sawImage && cursor + 1 === bytes.length;
    }

    if (introducer === 0x21) {
      if (bytes.length - cursor < 3) {
        return false;
      }
      const next = skipGifSubBlocks(bytes, cursor + 2);
      if (next === null) {
        return false;
      }
      cursor = next;
      continue;
    }

    if (introducer !== 0x2c || bytes.length - cursor < 10) {
      return false;
    }

    const imageWidth = bytes.readUInt16LE(cursor + 5);
    const imageHeight = bytes.readUInt16LE(cursor + 7);
    const imagePacked = bytes.readUInt8(cursor + 9);
    const hasLocalColorTable = (imagePacked & 0x80) !== 0;
    const localColorTableLength = hasLocalColorTable ? 3 * 2 ** ((imagePacked & 0x07) + 1) : 0;
    cursor += 10 + localColorTableLength;
    if (
      imageWidth === 0 ||
      imageHeight === 0 ||
      !(hasGlobalColorTable || hasLocalColorTable) ||
      cursor >= bytes.length
    ) {
      return false;
    }

    const minimumCodeSize = bytes.readUInt8(cursor);
    if (
      minimumCodeSize < 2 ||
      minimumCodeSize > 8 ||
      cursor + 1 >= bytes.length ||
      bytes.readUInt8(cursor + 1) === 0
    ) {
      return false;
    }
    const next = skipGifSubBlocks(bytes, cursor + 1);
    if (next === null) {
      return false;
    }
    sawImage = true;
    cursor = next;
  }

  return false;
}

function isValidVp8Chunk(bytes: Buffer, dataStart: number, dataLength: number): boolean {
  if (dataLength < 10) {
    return false;
  }

  const frameTag = bytes.readUIntLE(dataStart, 3);
  const firstPartitionLength = frameTag >>> 5;
  const width = bytes.readUInt16LE(dataStart + 6) & 0x3f_ff;
  const height = bytes.readUInt16LE(dataStart + 8) & 0x3f_ff;
  return (
    (frameTag & 1) === 0 &&
    bytes.readUInt8(dataStart + 3) === 0x9d &&
    bytes.readUInt8(dataStart + 4) === 0x01 &&
    bytes.readUInt8(dataStart + 5) === 0x2a &&
    firstPartitionLength <= dataLength - 3 &&
    width > 0 &&
    height > 0
  );
}

function isValidVp8lChunk(bytes: Buffer, dataStart: number, dataLength: number): boolean {
  return (
    dataLength >= 5 &&
    bytes.readUInt8(dataStart) === 0x2f &&
    (bytes.readUInt8(dataStart + 4) & 0xe0) === 0
  );
}

function isValidAnmfChunk(bytes: Buffer, dataStart: number, dataLength: number): boolean {
  if (dataLength < 24) {
    return false;
  }

  const frameEnd = dataStart + dataLength;
  let cursor = dataStart + 16;
  let sawImageData = false;
  while (cursor < frameEnd) {
    if (frameEnd - cursor < 8) {
      return false;
    }

    const chunkType = bytes.subarray(cursor, cursor + 4).toString('ascii');
    const nestedDataLength = bytes.readUInt32LE(cursor + 4);
    const nestedDataStart = cursor + 8;
    const nestedDataEnd = nestedDataStart + nestedDataLength;
    const nestedChunkEnd = nestedDataEnd + (nestedDataLength % 2);
    if (nestedChunkEnd > frameEnd) {
      return false;
    }

    if (chunkType === 'VP8 ') {
      sawImageData = isValidVp8Chunk(bytes, nestedDataStart, nestedDataLength);
    } else if (chunkType === 'VP8L') {
      sawImageData = isValidVp8lChunk(bytes, nestedDataStart, nestedDataLength);
    }
    if ((chunkType === 'VP8 ' || chunkType === 'VP8L') && !sawImageData) {
      return false;
    }
    cursor = nestedChunkEnd;
  }

  return sawImageData && cursor === frameEnd;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: WebP chunk validation is a linear format state machine.
function isValidWebp(bytes: Buffer): boolean {
  if (bytes.length < 20 || bytes.readUInt32LE(4) !== bytes.length - 8) {
    return false;
  }

  let cursor = 12;
  let sawImageData = false;
  while (cursor < bytes.length) {
    if (bytes.length - cursor < 8) {
      return false;
    }

    const chunkType = bytes.subarray(cursor, cursor + 4).toString('ascii');
    const dataLength = bytes.readUInt32LE(cursor + 4);
    const dataStart = cursor + 8;
    const dataEnd = dataStart + dataLength;
    const chunkEnd = dataEnd + (dataLength % 2);
    if (dataEnd > bytes.length || chunkEnd > bytes.length) {
      return false;
    }

    if (chunkType === 'VP8 ') {
      if (!isValidVp8Chunk(bytes, dataStart, dataLength)) {
        return false;
      }
      sawImageData = true;
    } else if (chunkType === 'VP8L') {
      if (!isValidVp8lChunk(bytes, dataStart, dataLength)) {
        return false;
      }
      sawImageData = true;
    } else if (chunkType === 'VP8X') {
      if (dataLength !== 10) {
        return false;
      }
    } else if (chunkType === 'ANMF') {
      if (!isValidAnmfChunk(bytes, dataStart, dataLength)) {
        return false;
      }
      sawImageData = true;
    }

    cursor = chunkEnd;
  }

  return sawImageData && cursor === bytes.length;
}

export function inspectSupportedImageFormat(bytes: Buffer): ImageFormatInspection | null {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return { mediaType: 'image/png', isValid: isValidPng(bytes) };
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mediaType: 'image/jpeg', isValid: isValidJpeg(bytes) };
  }

  if (bytes.length >= 6) {
    const signature = bytes.subarray(0, 6).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') {
      return { mediaType: 'image/gif', isValid: isValidGif(bytes) };
    }
  }

  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mediaType: 'image/webp', isValid: isValidWebp(bytes) };
  }

  return null;
}
