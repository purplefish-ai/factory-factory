import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clipboardEventHasImageItem,
  getClipboardImages,
  isLargeText,
  LARGE_TEXT_CHAR_THRESHOLD,
  LARGE_TEXT_LINE_THRESHOLD,
} from './paste-utils';

vi.mock('./image-utils', async () => {
  const actual = await vi.importActual<typeof import('./image-utils')>('./image-utils');
  return {
    ...actual,
    fileToBase64: vi.fn().mockResolvedValue('base64-data'),
    generateAttachmentId: () => 'att-test',
    MAX_IMAGE_SIZE: 5,
  };
});

vi.mock('./clipboard-image', () => ({
  getClipboardImageBlob: vi.fn().mockResolvedValue(null),
}));

import { getClipboardImageBlob } from './clipboard-image';
import { fileToBase64, MAX_IMAGE_SIZE } from './image-utils';

function createClipboardEvent(items?: DataTransferItem[]): ClipboardEvent {
  const event = new Event('paste') as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', {
    value: items ? { items } : undefined,
    configurable: true,
  });
  return event;
}

function createClipboardItem(options: {
  type: string;
  file?: File | null;
  kind?: string;
}): DataTransferItem {
  return {
    kind: options.kind ?? 'file',
    type: options.type,
    getAsFile: () => options.file ?? null,
  } as DataTransferItem;
}

describe('getClipboardImages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty results when clipboard data is missing', async () => {
    const result = await getClipboardImages(createClipboardEvent());
    expect(result).toEqual({ attachments: [], errors: [] });
  });

  it('creates an image attachment for a supported clipboard image', async () => {
    const file = {
      name: 'clip.png',
      size: 4,
      type: 'image/png',
    } as File;
    const item = createClipboardItem({ type: 'image/png', file });
    const result = await getClipboardImages(createClipboardEvent([item]));

    expect(fileToBase64).toHaveBeenCalledWith(file);
    expect(result.errors).toEqual([]);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      id: 'att-test',
      name: 'clip.png',
      type: 'image/png',
      size: 4,
      data: 'base64-data',
      contentType: 'image',
    });
  });

  it('collects an error when an image cannot be extracted', async () => {
    const item = createClipboardItem({ type: 'image/png', file: null });
    const result = await getClipboardImages(createClipboardEvent([item]));

    expect(result.attachments).toEqual([]);
    expect(result.errors).toEqual(['Could not extract image from clipboard (image/png)']);
  });

  it('collects an error when an image exceeds the size limit', async () => {
    const file = {
      name: 'big.png',
      size: MAX_IMAGE_SIZE + 1,
      type: 'image/png',
    } as File;
    const item = createClipboardItem({ type: 'image/png', file });
    const result = await getClipboardImages(createClipboardEvent([item]));

    expect(result.attachments).toEqual([]);
    expect(result.errors).toEqual(['Image too large: 6 B (max 5 B)']);
  });

  it('captures the item type synchronously before the clipboard item is neutered', async () => {
    // Real clipboard DataTransferItems neuter after the paste event / first
    // await: getAsFile() succeeds once, then item.type reads back as ''. The
    // attachment must still carry the original type, not the neutered empty one.
    const file = { name: '', size: 4, type: 'image/png' } as File;
    let neutered = false;
    const item = {
      kind: 'file',
      get type() {
        return neutered ? '' : 'image/png';
      },
      getAsFile: () => {
        neutered = true;
        return file;
      },
    } as unknown as DataTransferItem;

    const result = await getClipboardImages(createClipboardEvent([item]));

    expect(getClipboardImageBlob).not.toHaveBeenCalled();
    expect(result.errors).toEqual([]);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({ type: 'image/png', contentType: 'image' });
  });

  it('falls back to the platform PNG channel for an unsupported image type', async () => {
    const pngBlob = { size: 4, type: 'image/png' } as Blob;
    vi.mocked(getClipboardImageBlob).mockResolvedValueOnce(pngBlob);

    // A macOS screenshot's TIFF representation: present but not directly usable.
    const tiffItem = createClipboardItem({ type: 'image/tiff', file: null });
    const result = await getClipboardImages(createClipboardEvent([tiffItem]));

    expect(getClipboardImageBlob).toHaveBeenCalledTimes(1);
    expect(result.errors).toEqual([]);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      type: 'image/png',
      size: 4,
      data: 'base64-data',
      contentType: 'image',
    });
  });

  it('does not use the platform fallback when a supported image was extracted', async () => {
    const file = { name: 'clip.png', size: 4, type: 'image/png' } as File;
    const item = createClipboardItem({ type: 'image/png', file });

    await getClipboardImages(createClipboardEvent([item]));

    expect(getClipboardImageBlob).not.toHaveBeenCalled();
  });
});

describe('clipboardEventHasImageItem', () => {
  it('matches an unsupported image file item (macOS screenshot TIFF)', () => {
    const item = createClipboardItem({ type: 'image/tiff', file: null });
    expect(clipboardEventHasImageItem(createClipboardEvent([item]))).toBe(true);
  });

  it('matches a file item with an empty type', () => {
    const item = createClipboardItem({ type: '', file: null });
    expect(clipboardEventHasImageItem(createClipboardEvent([item]))).toBe(true);
  });

  it('ignores pasted text (string items)', () => {
    const item = createClipboardItem({ type: 'text/plain', kind: 'string' });
    expect(clipboardEventHasImageItem(createClipboardEvent([item]))).toBe(false);
  });

  it('returns false when there is no clipboard data', () => {
    expect(clipboardEventHasImageItem(createClipboardEvent())).toBe(false);
  });
});

describe('isLargeText', () => {
  it('returns false below both thresholds', () => {
    const text = 'short text';
    expect(isLargeText(text)).toBe(false);
  });

  it('returns true at the line threshold', () => {
    const text = Array.from({ length: LARGE_TEXT_LINE_THRESHOLD }, () => 'line').join('\n');
    expect(isLargeText(text)).toBe(true);
  });

  it('returns false just below the line threshold', () => {
    const text = Array.from({ length: LARGE_TEXT_LINE_THRESHOLD - 1 }, () => 'line').join('\n');
    expect(isLargeText(text)).toBe(false);
  });

  it('returns true at the character threshold', () => {
    const text = 'a'.repeat(LARGE_TEXT_CHAR_THRESHOLD);
    expect(isLargeText(text)).toBe(true);
  });

  it('returns false just below the character threshold', () => {
    const text = 'a'.repeat(LARGE_TEXT_CHAR_THRESHOLD - 1);
    expect(isLargeText(text)).toBe(false);
  });
});
