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
const PNG_BIT_DEPTHS_BY_COLOR_TYPE = new Map<number, ReadonlySet<number>>([
  [0, new Set([1, 2, 4, 8, 16])],
  [2, new Set([8, 16])],
  [3, new Set([1, 2, 4, 8])],
  [4, new Set([8, 16])],
  [6, new Set([8, 16])],
]);

function startsWith(bytes: Buffer, signature: Buffer): boolean {
  return bytes.length >= signature.length && bytes.subarray(0, signature.length).equals(signature);
}

interface PngChunk {
  type: string;
  dataStart: number;
  dataLength: number;
  end: number;
}

function readPngChunks(bytes: Buffer): PngChunk[] | null {
  let cursor = PNG_SIGNATURE.length;
  const chunks: PngChunk[] = [];

  while (cursor < bytes.length) {
    if (bytes.length - cursor < 12) {
      return null;
    }

    const dataLength = bytes.readUInt32BE(cursor);
    if (dataLength > bytes.length - cursor - 12) {
      return null;
    }

    const typeStart = cursor + 4;
    const dataStart = typeStart + 4;
    const dataEnd = dataStart + dataLength;
    const chunkEnd = dataEnd + 4;
    const chunkType = bytes.subarray(typeStart, dataStart).toString('ascii');
    if (crc32(bytes.subarray(typeStart, dataEnd)) !== bytes.readUInt32BE(dataEnd)) {
      return null;
    }

    chunks.push({ type: chunkType, dataStart, dataLength, end: chunkEnd });
    cursor = chunkEnd;
  }

  return chunks;
}

function isValidPngHeader(bytes: Buffer, chunk: PngChunk): boolean {
  if (chunk.type !== 'IHDR' || chunk.dataLength !== 13) {
    return false;
  }

  const bitDepth = bytes.readUInt8(chunk.dataStart + 8);
  const colorType = bytes.readUInt8(chunk.dataStart + 9);
  const interlaceMethod = bytes.readUInt8(chunk.dataStart + 12);
  return (
    bytes.readUInt32BE(chunk.dataStart) > 0 &&
    bytes.readUInt32BE(chunk.dataStart + 4) > 0 &&
    PNG_BIT_DEPTHS_BY_COLOR_TYPE.get(colorType)?.has(bitDepth) === true &&
    bytes.readUInt8(chunk.dataStart + 10) === 0 &&
    bytes.readUInt8(chunk.dataStart + 11) === 0 &&
    (interlaceMethod === 0 || interlaceMethod === 1)
  );
}

function findLastPngChunkIndex(chunks: PngChunk[], type: string): number {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    if (chunks[index]?.type === type) {
      return index;
    }
  }
  return -1;
}

function isValidPng(bytes: Buffer): boolean {
  const chunks = readPngChunks(bytes);
  const header = chunks?.[0];
  const finalChunk = chunks?.at(-1);
  if (!(chunks && header)) {
    return false;
  }
  if (
    !(finalChunk && isValidPngHeader(bytes, header)) ||
    finalChunk.type !== 'IEND' ||
    finalChunk.dataLength !== 0 ||
    finalChunk.end !== bytes.length
  ) {
    return false;
  }

  const firstImageData = chunks.findIndex((chunk) => chunk.type === 'IDAT');
  const lastImageData = findLastPngChunkIndex(chunks, 'IDAT');
  return (
    firstImageData > 0 &&
    chunks.slice(firstImageData, lastImageData + 1).every((chunk) => chunk.type === 'IDAT') &&
    chunks.slice(1).every((chunk) => chunk.type !== 'IHDR') &&
    chunks.slice(0, -1).every((chunk) => chunk.type !== 'IEND')
  );
}

interface JpegValidationState {
  cursor: number;
  pendingMarker: number | null;
  sawFrame: boolean;
  sawScan: boolean;
}

interface JpegSegment {
  start: number;
  length: number;
  end: number;
}

function readJpegMarker(bytes: Buffer, state: JpegValidationState): number | null {
  if (state.pendingMarker !== null) {
    const marker = state.pendingMarker;
    state.pendingMarker = null;
    return marker;
  }
  if (state.cursor >= bytes.length || bytes.readUInt8(state.cursor) !== 0xff) {
    return null;
  }

  while (state.cursor < bytes.length && bytes.readUInt8(state.cursor) === 0xff) {
    state.cursor += 1;
  }
  if (state.cursor === bytes.length || bytes.readUInt8(state.cursor) === 0x00) {
    return null;
  }

  const marker = bytes.readUInt8(state.cursor);
  state.cursor += 1;
  return marker;
}

function readJpegSegment(bytes: Buffer, start: number): JpegSegment | null {
  if (bytes.length - start < 2) {
    return null;
  }
  const length = bytes.readUInt16BE(start);
  if (length < 2 || length > bytes.length - start) {
    return null;
  }
  return { start, length, end: start + length };
}

function isValidJpegFrame(bytes: Buffer, segment: JpegSegment): boolean {
  if (segment.length < 11) {
    return false;
  }
  const componentCount = bytes.readUInt8(segment.start + 7);
  return (
    bytes.readUInt16BE(segment.start + 3) > 0 &&
    bytes.readUInt16BE(segment.start + 5) > 0 &&
    componentCount > 0 &&
    segment.length === 8 + 3 * componentCount
  );
}

function isValidJpegScanHeader(bytes: Buffer, segment: JpegSegment): boolean {
  const componentCount = bytes.readUInt8(segment.start + 2);
  return componentCount > 0 && segment.length === 6 + 2 * componentCount;
}

function consumeJpegScanData(bytes: Buffer, state: JpegValidationState): boolean {
  let sawEntropyData = false;
  while (state.cursor < bytes.length) {
    if (bytes.readUInt8(state.cursor) !== 0xff) {
      sawEntropyData = true;
      state.cursor += 1;
      continue;
    }

    while (state.cursor < bytes.length && bytes.readUInt8(state.cursor) === 0xff) {
      state.cursor += 1;
    }
    if (state.cursor === bytes.length) {
      return false;
    }

    const marker = bytes.readUInt8(state.cursor);
    state.cursor += 1;
    if (marker === 0x00) {
      sawEntropyData = true;
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      continue;
    }

    state.pendingMarker = marker;
    return sawEntropyData;
  }
  return false;
}

function isStandaloneJpegMarker(marker: number): boolean {
  return marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

type JpegMarkerResult = 'continue' | 'complete' | 'invalid';

function consumeJpegMarker(
  bytes: Buffer,
  state: JpegValidationState,
  marker: number
): JpegMarkerResult {
  if (marker === 0xd9) {
    return state.sawFrame && state.sawScan && state.cursor === bytes.length
      ? 'complete'
      : 'invalid';
  }
  if (isStandaloneJpegMarker(marker)) {
    return 'invalid';
  }

  const segment = readJpegSegment(bytes, state.cursor);
  if (!segment) {
    return 'invalid';
  }
  if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
    if (!isValidJpegFrame(bytes, segment)) {
      return 'invalid';
    }
    state.sawFrame = true;
  }

  state.cursor = segment.end;
  if (marker !== 0xda) {
    return 'continue';
  }
  if (!(isValidJpegScanHeader(bytes, segment) && consumeJpegScanData(bytes, state))) {
    return 'invalid';
  }
  state.sawScan = true;
  return 'continue';
}

function isValidJpeg(bytes: Buffer): boolean {
  const state: JpegValidationState = {
    cursor: 2,
    pendingMarker: null,
    sawFrame: false,
    sawScan: false,
  };

  while (state.cursor < bytes.length || state.pendingMarker !== null) {
    const marker = readJpegMarker(bytes, state);
    const result = marker === null ? 'invalid' : consumeJpegMarker(bytes, state, marker);
    if (result === 'complete') {
      return true;
    }
    if (result === 'invalid') {
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

interface GifHeader {
  firstBlock: number;
  hasGlobalColorTable: boolean;
}

function readGifHeader(bytes: Buffer): GifHeader | null {
  if (bytes.length < 14) {
    return null;
  }

  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  if (width === 0 || height === 0) {
    return null;
  }

  const logicalScreenPacked = bytes.readUInt8(10);
  const hasGlobalColorTable = (logicalScreenPacked & 0x80) !== 0;
  const globalColorTableLength = hasGlobalColorTable
    ? 3 * 2 ** ((logicalScreenPacked & 0x07) + 1)
    : 0;
  const firstBlock = 13 + globalColorTableLength;
  if (firstBlock > bytes.length) {
    return null;
  }

  return { firstBlock, hasGlobalColorTable };
}

function readGifImageBlock(
  bytes: Buffer,
  start: number,
  hasGlobalColorTable: boolean
): number | null {
  if (bytes.length - start < 10) {
    return null;
  }

  const imageWidth = bytes.readUInt16LE(start + 5);
  const imageHeight = bytes.readUInt16LE(start + 7);
  const imagePacked = bytes.readUInt8(start + 9);
  const hasLocalColorTable = (imagePacked & 0x80) !== 0;
  const localColorTableLength = hasLocalColorTable ? 3 * 2 ** ((imagePacked & 0x07) + 1) : 0;
  const codeSizeOffset = start + 10 + localColorTableLength;
  if (
    imageWidth === 0 ||
    imageHeight === 0 ||
    !(hasGlobalColorTable || hasLocalColorTable) ||
    codeSizeOffset + 1 >= bytes.length
  ) {
    return null;
  }

  const minimumCodeSize = bytes.readUInt8(codeSizeOffset);
  if (minimumCodeSize < 2 || minimumCodeSize > 8 || bytes.readUInt8(codeSizeOffset + 1) === 0) {
    return null;
  }
  return skipGifSubBlocks(bytes, codeSizeOffset + 1);
}

interface GifValidationState {
  cursor: number;
  sawImage: boolean;
}

type GifBlockResult = 'continue' | 'complete' | 'invalid';

function consumeGifBlock(
  bytes: Buffer,
  header: GifHeader,
  state: GifValidationState
): GifBlockResult {
  const introducer = bytes.readUInt8(state.cursor);
  if (introducer === 0x3b) {
    return state.sawImage && state.cursor + 1 === bytes.length ? 'complete' : 'invalid';
  }
  if (introducer === 0x21) {
    if (bytes.length - state.cursor < 3) {
      return 'invalid';
    }
    const next = skipGifSubBlocks(bytes, state.cursor + 2);
    if (next === null) {
      return 'invalid';
    }
    state.cursor = next;
    return 'continue';
  }
  if (introducer !== 0x2c) {
    return 'invalid';
  }

  const next = readGifImageBlock(bytes, state.cursor, header.hasGlobalColorTable);
  if (next === null) {
    return 'invalid';
  }
  state.cursor = next;
  state.sawImage = true;
  return 'continue';
}

function isValidGif(bytes: Buffer): boolean {
  const header = readGifHeader(bytes);
  if (!header) {
    return false;
  }

  const state: GifValidationState = { cursor: header.firstBlock, sawImage: false };
  while (state.cursor < bytes.length) {
    const result = consumeGifBlock(bytes, header, state);
    if (result === 'complete') {
      return true;
    }
    if (result === 'invalid') {
      return false;
    }
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
    firstPartitionLength <= dataLength - 10 &&
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

interface RiffChunk {
  type: string;
  dataStart: number;
  dataLength: number;
}

function readRiffChunks(bytes: Buffer, start: number, end: number): RiffChunk[] | null {
  let cursor = start;
  const chunks: RiffChunk[] = [];
  while (cursor < end) {
    if (end - cursor < 8) {
      return null;
    }

    const type = bytes.subarray(cursor, cursor + 4).toString('ascii');
    const dataLength = bytes.readUInt32LE(cursor + 4);
    const dataStart = cursor + 8;
    const dataEnd = dataStart + dataLength;
    const chunkEnd = dataEnd + (dataLength % 2);
    if (chunkEnd > end) {
      return null;
    }

    chunks.push({ type, dataStart, dataLength });
    cursor = chunkEnd;
  }
  return cursor === end ? chunks : null;
}

function inspectSimpleWebpImageChunk(bytes: Buffer, chunk: RiffChunk): boolean | null {
  if (chunk.type === 'VP8 ') {
    return isValidVp8Chunk(bytes, chunk.dataStart, chunk.dataLength);
  }
  if (chunk.type === 'VP8L') {
    return isValidVp8lChunk(bytes, chunk.dataStart, chunk.dataLength);
  }
  return null;
}

function isValidAnmfChunk(bytes: Buffer, dataStart: number, dataLength: number): boolean {
  if (dataLength < 24) {
    return false;
  }

  const frameEnd = dataStart + dataLength;
  const chunks = readRiffChunks(bytes, dataStart + 16, frameEnd);
  if (!chunks) {
    return false;
  }

  let sawImageData = false;
  for (const chunk of chunks) {
    const imageChunkValid = inspectSimpleWebpImageChunk(bytes, chunk);
    if (imageChunkValid === false) {
      return false;
    }
    if (imageChunkValid) {
      sawImageData = true;
    }
  }

  return sawImageData;
}

const WEBP_ANIMATION_FLAG = 0x02;

interface WebpValidationState {
  hasAnimationFlag: boolean;
  sawAnimationControl: boolean;
  sawAnimationFrame: boolean;
  sawStillImage: boolean;
}

function createWebpValidationState(bytes: Buffer, chunks: RiffChunk[]): WebpValidationState | null {
  const firstChunk = chunks[0];
  const hasExtendedHeader = firstChunk?.type === 'VP8X';
  if (hasExtendedHeader && firstChunk.dataLength !== 10) {
    return null;
  }
  const hasAnimationFlag =
    hasExtendedHeader && (bytes.readUInt8(firstChunk.dataStart) & WEBP_ANIMATION_FLAG) !== 0;
  return {
    hasAnimationFlag,
    sawAnimationControl: false,
    sawAnimationFrame: false,
    sawStillImage: false,
  };
}

function consumeWebpAnimationControl(chunk: RiffChunk, state: WebpValidationState): boolean {
  if (!state.hasAnimationFlag) {
    return true;
  }
  if (chunk.dataLength !== 6 || state.sawAnimationControl || state.sawAnimationFrame) {
    return false;
  }
  state.sawAnimationControl = true;
  return true;
}

function consumeWebpAnimationFrame(
  bytes: Buffer,
  chunk: RiffChunk,
  state: WebpValidationState
): boolean {
  if (
    !(
      state.hasAnimationFlag &&
      state.sawAnimationControl &&
      isValidAnmfChunk(bytes, chunk.dataStart, chunk.dataLength)
    )
  ) {
    return false;
  }
  state.sawAnimationFrame = true;
  return true;
}

function consumeWebpChunk(
  bytes: Buffer,
  chunk: RiffChunk,
  index: number,
  state: WebpValidationState
): boolean {
  const simpleImageValid = inspectSimpleWebpImageChunk(bytes, chunk);
  if (simpleImageValid !== null) {
    if (!simpleImageValid || state.hasAnimationFlag || state.sawStillImage) {
      return false;
    }
    state.sawStillImage = true;
    return true;
  }
  if (chunk.type === 'VP8X') {
    return index === 0;
  }
  if (chunk.type === 'ANIM') {
    return consumeWebpAnimationControl(chunk, state);
  }
  if (chunk.type === 'ANMF') {
    return consumeWebpAnimationFrame(bytes, chunk, state);
  }
  return true;
}

function isValidWebp(bytes: Buffer): boolean {
  const chunks =
    bytes.length >= 20 && bytes.readUInt32LE(4) === bytes.length - 8
      ? readRiffChunks(bytes, 12, bytes.length)
      : null;
  const state = chunks ? createWebpValidationState(bytes, chunks) : null;
  if (!(chunks && state)) {
    return false;
  }

  const chunksAreValid = chunks.every((chunk, index) =>
    consumeWebpChunk(bytes, chunk, index, state)
  );
  if (!chunksAreValid) {
    return false;
  }

  return state.hasAnimationFlag
    ? state.sawAnimationControl && state.sawAnimationFrame
    : state.sawStillImage && !state.sawAnimationFrame;
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
