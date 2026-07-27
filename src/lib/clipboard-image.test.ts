// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getClipboardImageBlob } from './clipboard-image';
import { MAX_IMAGE_SIZE } from './image-utils';

function base64OfLength(length: number): string {
  return 'A'.repeat(length);
}

function setElectronAPI(value: Window['electronAPI']): void {
  Object.defineProperty(window, 'electronAPI', { value, configurable: true, writable: true });
}

function setNavigatorClipboard(value: Clipboard | undefined): void {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true, writable: true });
}

describe('getClipboardImageBlob', () => {
  const originalElectronAPI = window.electronAPI;
  const originalClipboard = navigator.clipboard;

  beforeEach(() => {
    setElectronAPI(undefined);
    setNavigatorClipboard(undefined);
  });

  afterEach(() => {
    setElectronAPI(originalElectronAPI);
    setNavigatorClipboard(originalClipboard);
    vi.restoreAllMocks();
  });

  it('returns null when neither channel is available', async () => {
    await expect(getClipboardImageBlob()).resolves.toBeNull();
  });

  it('falls back to the async Clipboard API when the Electron IPC call rejects', async () => {
    setElectronAPI({
      isElectron: true,
      showOpenDialog: vi.fn(),
      readClipboardImageAsPng: vi.fn().mockRejectedValue(new Error('IPC failure')),
    });
    const blob = new Blob(['png-bytes'], { type: 'image/png' });
    setNavigatorClipboard({
      read: vi.fn().mockResolvedValue([
        {
          types: ['image/png'],
          getType: vi.fn().mockResolvedValue(blob),
        },
      ]),
    } as unknown as Clipboard);

    await expect(getClipboardImageBlob()).resolves.toBe(blob);
  });

  it('falls back to the async Clipboard API when getType rejects for one item', async () => {
    const blob = new Blob(['png-bytes'], { type: 'image/png' });
    setNavigatorClipboard({
      read: vi.fn().mockResolvedValue([
        {
          types: ['image/png'],
          getType: vi.fn().mockRejectedValue(new Error('decode failure')),
        },
        {
          types: ['image/png'],
          getType: vi.fn().mockResolvedValue(blob),
        },
      ]),
    } as unknown as Clipboard);

    await expect(getClipboardImageBlob()).resolves.toBe(blob);
  });

  it('rejects an oversized base64 payload from the Electron channel without decoding it', async () => {
    setElectronAPI({
      isElectron: true,
      showOpenDialog: vi.fn(),
      readClipboardImageAsPng: vi
        .fn()
        .mockResolvedValue(base64OfLength(Math.ceil(MAX_IMAGE_SIZE / 3) * 4 + 4)),
    });

    await expect(getClipboardImageBlob()).resolves.toBeNull();
  });
});
