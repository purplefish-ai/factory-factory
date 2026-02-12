import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getClipboardImages } from './paste-utils';

vi.mock('./image-utils', async () => {
  const actual = await vi.importActual<typeof import('./image-utils')>('./image-utils');
  return {
    ...actual,
    fileToBase64: vi.fn().mockResolvedValue('base64-data'),
    generateAttachmentId: () => 'att-test',
    MAX_IMAGE_SIZE: 5,
  };
});

import { fileToBase64, MAX_IMAGE_SIZE } from './image-utils';

function createClipboardEvent(items?: DataTransferItem[]): ClipboardEvent {
  const event = new Event('paste') as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', {
    value: items ? { items } : undefined,
    configurable: true,
  });
  return event;
}

function createClipboardItem(options: { type: string; file?: File | null }): DataTransferItem {
  return {
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
});
