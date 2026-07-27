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

const PNG_MIME = 'image/png';

function base64ToBlob(base64: string, type: string): Blob {
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

  const base64 = await api.readClipboardImageAsPng();
  if (!base64) {
    return null;
  }

  return base64ToBlob(base64, PNG_MIME);
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
      return item.getType(PNG_MIME);
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
