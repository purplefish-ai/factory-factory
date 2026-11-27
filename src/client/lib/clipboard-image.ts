/**
 * Clipboard image access.
 *
 * macOS places screenshots on the clipboard as TIFF (`public.tiff`). The legacy
 * `paste`-event `DataTransferItem` path can surface that with an unusable or
 * empty MIME type, and the browser's own `<canvas>`/`createImageBitmap` decoders
 * cannot read TIFF at all. The async Clipboard API (`navigator.clipboard.read()`)
 * instead exposes a normalized `image/png` representation of the *current*
 * clipboard, even when the legacy paste path only offered TIFF.
 *
 * Used as a fallback by the paste handler when the paste event carried image
 * data but nothing directly usable could be extracted from it.
 */

const PNG_MIME = 'image/png';

/**
 * Get the current clipboard image as a Blob, or null if no image is available
 * or the async Clipboard API is unsupported/denied.
 */
export async function getClipboardImageBlob(): Promise<Blob | null> {
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
