// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClipboardImageBlob } from './clipboard-image';

function setNavigatorClipboard(value: Clipboard | undefined): void {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true, writable: true });
}

describe('getClipboardImageBlob', () => {
  const originalClipboard = navigator.clipboard;

  beforeEach(() => {
    setNavigatorClipboard(undefined);
  });

  afterEach(() => {
    setNavigatorClipboard(originalClipboard);
    vi.restoreAllMocks();
  });

  it('returns null when the async Clipboard API is unavailable', async () => {
    await expect(getClipboardImageBlob()).resolves.toBeNull();
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
});
