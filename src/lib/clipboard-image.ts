/**
 * Platform-native clipboard image access.
 *
 * macOS places screenshots on the clipboard as TIFF (`public.tiff`). The legacy
 * `paste`-event `DataTransferItem` path can surface that with an unusable or
 * empty MIME type, and the browser's own `<canvas>`/`createImageBitmap` decoders
 * cannot read TIFF at all. The two channels below instead ask the OS/browser for
 * a PNG representation of the *current* clipboard directly, sidestepping that
 * mapping entirely:
 *
 * - Electron: the main process bridges `clipboard.readImage().toPNG()` (the OS
 *   performs the conversion; no permission prompt).
 * - Web: the async Clipboard API (`navigator.clipboard.read()`) exposes a
 *   normalized `image/png` representation even when the legacy paste path only
 *   offered TIFF.
 *
 * Used as a fallback by the paste handler when the paste event carried image
 * data but nothing directly usable could be extracted from it.
 */

import { MAX_IMAGE_SIZE } from './image-utils';

const PNG_MIME = 'image/png';

// Base64 encodes 3 bytes as 4 characters, but the final group may be padded
// with '=' to represent only 1 or 2 trailing bytes. A length-only estimate
// rounds up to the nearest group of 4 and can therefore admit payloads up to
// 2 bytes over the limit; deriving the exact decoded size from the padding
// closes that gap.
function base64DecodedByteLength(base64: string): number {
  if (base64.length === 0 || base64.length % 4 !== 0) {
    return Number.POSITIVE_INFINITY;
  }

  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

function base64ToBlob(base64: string, type: string): Blob | null {
  if (base64DecodedByteLength(base64) > MAX_IMAGE_SIZE) {
    return null;
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type });
}

async function readFromElectron(): Promise<Blob | null> {
  const api = window.electronAPI;
  if (!api?.readClipboardImageAsPng) {
    return null;
  }

  try {
    const base64 = await api.readClipboardImageAsPng();
    if (!base64) {
      return null;
    }

    return base64ToBlob(base64, PNG_MIME);
  } catch {
    // IPC failure — the caller falls back to the next channel.
    return null;
  }
}

async function readFromAsyncClipboard(): Promise<Blob | null> {
  if (!navigator.clipboard?.read) {
    return null;
  }

  let items: ClipboardItem[];
  try {
    items = await navigator.clipboard.read();
  } catch {
    // Permission denied, missing transient activation, or unsupported — the
    // caller falls back to whatever the paste event already provided.
    return null;
  }

  for (const item of items) {
    // Chromium's async Clipboard API decodes and re-encodes images to PNG, so a
    // macOS screenshot's TIFF is exposed here as a clean `image/png`.
    if (item.types.includes(PNG_MIME)) {
      try {
        return await item.getType(PNG_MIME);
      } catch {
        // This item's PNG representation failed to materialize — the loop
        // continues to check any remaining items.
      }
    }
  }

  return null;
}

/**
 * Get the current clipboard image as a Blob, or null if no image is available
 * or the platform channels are unsupported/denied. Tries the Electron
 * main-process clipboard first (no permission prompt), then the async Clipboard
 * API.
 */
export async function getClipboardImageBlob(): Promise<Blob | null> {
  const fromElectron = await readFromElectron();
  if (fromElectron) {
    return fromElectron;
  }

  return readFromAsyncClipboard();
}
