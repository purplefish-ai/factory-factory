# Design Doc: Clipboard Screenshot Paste Fails with "Unsupported image format (unknown)"

> **Status:** Option A implemented. The paste handler now falls back to a platform PNG channel (Electron `clipboard.readImage().toPNG()` bridge + web `navigator.clipboard.read()`) when the paste event carries image data that isn't a directly-usable supported type (e.g. a macOS screenshot's TIFF). Options B/C remain documented as fallbacks if a raw image still slips through. See "Implementation status" below.

## Summary

Pasting a macOS screenshot (Cmd+Ctrl+Shift+4, copy-to-clipboard) into the "create task" input fails with:

```
Unsupported image format "(unknown)". Supported formats: JPEG, PNG, GIF, WebP.
```

Attaching the exact same screenshot from disk via the file picker works fine. The root cause is architectural, not a simple typo: **every layer of the attachment pipeline — client paste handler, client file handler, and backend validator — decides "is this a supported image" by trusting a browser/OS-reported MIME-type *string*, never by inspecting the actual image bytes.** For files opened via `<input type="file">`, Chromium reliably derives that string from the file's extension/OS type association. For images that only exist as a macOS clipboard *pasteboard* entry (no file on disk), that string is derived from OS/Chromium clipboard-flavor negotiation, which is materially less reliable — macOS screen-capture-to-clipboard is known to expose only a TIFF (`public.tiff`) representation in some capture modes, and Chromium's mapping of that OS flavor to a web `image/*` MIME type is inconsistent across capture paths, surfacing as `image/tiff` (not in either allow-list) or as an empty/unrecognized type string. Neither the client nor the server has any fallback for this — it's binary allow-or-reject with no byte-level sniffing and no transcoding.

A secondary, compounding bug: the client and backend maintain **two independent, drifted allow-lists** for supported image MIME types, so even a case that passes client-side validation is not guaranteed to pass server-side validation.

---

## Context and Motivation

Factory Factory's "create task" flow (`InlineWorkspaceForm`, used from the Kanban board) and the in-session chat input (`ChatInput`) share one image-attachment pipeline: paste/drop → client-side MIME allow-list check → base64-encode → send to backend as part of the initial/chat message → backend re-validates → forwarded to the agent (e.g. as Claude vision input).

There are two independent ways to get an image into this pipeline:

1. **File picker / drag-drop of a file** — the browser resolves `File.type` from the OS's file-type association (extension/UTI), which is dependable for real files.
2. **Clipboard paste** — the browser resolves `DataTransferItem.type` from whatever pasteboard "flavor" the OS clipboard exposes and however Chromium chooses to map it to a MIME string. There is no file, extension, or OS file-type association to lean on.

The bug report is specifically about (2): paste-only failure, with file-picker attach of the identical image working.

---

## Problem Statement

Users cannot reliably paste a screenshot (Cmd+V) into the create-task box after copying it via macOS's clipboard screenshot shortcut. The failure surfaces as a raw backend validation error rather than a clear, actionable message, and there is no automatic recovery (e.g. converting the image to a supported format).

---

## Root Cause Analysis

### Root Cause 1: The entire pipeline trusts a reported MIME string instead of sniffing bytes

**Client paste path** — `src/lib/paste-utils.ts:36-48, 64-109`:

```typescript
export function hasClipboardImages(event: ClipboardEvent): boolean {
  const items = event.clipboardData?.items;
  ...
  for (const item of Array.from(items)) {
    if (item.type.startsWith('image/') && isSupportedImageType(item.type)) {
      return true;
    }
  }
  return false;
}
```

```typescript
async function processClipboardImageItem(item: DataTransferItem) {
  const file = item.getAsFile();
  ...
  const base64 = await fileToBase64(file);
  return {
    attachment: {
      ...
      type: item.type,   // <-- whatever the browser/OS clipboard negotiation produced
      ...
    },
  };
}
```

**Client file-picker path** — `src/lib/image-utils.ts:97-118`:

```typescript
export async function fileToAttachment(file: File): Promise<MessageAttachment> {
  if (!isSupportedImageType(file.type)) {
    throw new Error(`Unsupported file type: ${file.type}`);
  }
  ...
}
```

Both paths gate on a string (`item.type` / `file.type`) with zero inspection of the underlying bytes. Neither path can recognize "this is actually a decodable image, just reported with the wrong/missing MIME type" versus "this is genuinely not an image."

**Backend re-validation** — `src/backend/services/session/service/chat/chat-message-handlers/attachment-processing.ts:15-20, 37-44, 81-89`:

```typescript
const SUPPORTED_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
...
export class UnsupportedImageTypeError extends PermanentAttachmentError {
  constructor(type: string) {
    super(`Unsupported image format "${type || '(unknown)'}". Supported formats: JPEG, PNG, GIF, WebP.`);
  }
}
...
function validateImageMediaType(attachment: MessageAttachment): void {
  if (!isSupportedImageMediaType(attachment.type)) {
    throw new UnsupportedImageTypeError(attachment.type);
  }
}
```

The `"(unknown)"` text is emitted specifically when `attachment.type` arrives as an **empty string** — confirming the client forwarded (or the browser produced) a MIME-less clipboard item. There is no image-format-detection library anywhere in the repo (`sharp`, `file-type`, `image-size`, etc. are all absent) — the backend, like the client, only ever echoes back the string it was handed. It cannot correct or recover from a bad type, only reject.

**Why clipboard specifically breaks:** macOS's screen-capture-to-clipboard shortcut (Cmd+Ctrl+Shift+4, or "Copy" from the screenshot thumbnail) places the image on the pasteboard as `public.tiff` — historically without a PNG flavor alongside it. Chromium's clipboard-read implementation, when reading `DataTransferItem`s from a pasteboard that offers only a TIFF flavor, does not consistently expose a clean `image/*` MIME string the way it does for a `File` opened from disk (where the OS file-type association is unambiguous). Depending on the exact capture method and Chromium build, this surfaces as `item.type === 'image/tiff'` (parses as `image/*` but isn't in either allow-list) or as an unset/empty type. This is a widely-reported failure class across other Chromium/Electron-based apps' "paste screenshot on Mac" features, for the same underlying reason: TIFF is a legitimate image format, but the pipeline was only ever built to recognize PNG/JPEG/GIF/WebP by name, not to decode-and-verify.

Because the client's own gate (`hasClipboardImages`, `getClipboardImageItems` — `paste-utils.ts:36-48, 64-68`) filters items to `item.type.startsWith('image/') && isSupportedImageType(item.type)` *before* an attachment is ever constructed, a cleanly-empty `item.type` should be silently dropped client-side (no attachment sent at all) under the current allow-list logic. The fact that the backend's exact validation string reaches the user indicates the type string that reached the server was non-empty and superficially valid enough to pass the client's (looser) gate but not the server's (stricter) one — see Root Cause 2 — or that the value degrades to empty somewhere between `DataTransferItem` filtering and the value actually transmitted (e.g. a differently-typed item within the same multi-flavor clipboard payload being the one ultimately read). Either way, the failure mode is the same class of bug: **a MIME string produced by OS/browser clipboard negotiation, not by inspecting bytes, is trusted as ground truth at every layer.**

### Root Cause 2 (compounding): Client and backend allow-lists have drifted independently

**Client** — `src/lib/image-utils.ts:8-14`:
```typescript
export const SUPPORTED_IMAGE_TYPES = [
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
] as const;
```

**Backend** — `attachment-processing.ts:15`:
```typescript
const SUPPORTED_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
```

The client accepts `image/jpg` (a non-standard but real-world MIME string some sources emit); the backend does not. Any clipboard/file source reporting `image/jpg` will pass client-side gating, be base64-encoded and sent, and then fail server-side with this same error class — a second, independent way to hit the bug. There is no single source of truth for "what image types does Factory Factory support."

### Root Cause 3: No transcoding/fallback path

Even when the underlying bytes are a perfectly valid, decodable raster image (TIFF is not corrupt data — it's just not one of the four whitelisted formats), the system has no capability to convert it into a supported format. The only two outcomes today are "pass through unchanged" or "reject." A screenshot util on macOS can trivially produce TIFF; there's no reason the product can't handle it. Note that the naive conversion — a client-side canvas transcode — cannot decode TIFF in Chromium; see the constraint call-out under [Recommended Fix](#recommended-fix), which is why the fix is organized around *where* conversion happens rather than just detection.

---

## Affected Code Paths

| File | Line(s) | Description |
|------|---------|-------------|
| `src/lib/paste-utils.ts` | 36-48 | `hasClipboardImages` — gates purely on `DataTransferItem.type` string |
| `src/lib/paste-utils.ts` | 64-68 | `getClipboardImageItems` — same string-only filter |
| `src/lib/paste-utils.ts` | 79-109 | `processClipboardImageItem` — forwards `item.type` verbatim, no byte sniffing |
| `src/lib/image-utils.ts` | 8-14 | `SUPPORTED_IMAGE_TYPES` — client allow-list (includes `image/jpg`) |
| `src/lib/image-utils.ts` | 58-60 | `isSupportedImageType` |
| `src/lib/image-utils.ts` | 97-118 | `fileToAttachment` — file-picker path, same string-trust pattern |
| `src/components/chat/chat-input/hooks/use-paste-drop-handler.ts` | 107-132 | `handlePaste` — wired to both create-task form and chat input |
| `src/client/components/kanban/inline-workspace-form.tsx` | ~692 | `onPaste={pasteDropHandler.handlePaste}` on the create-task textarea |
| `src/backend/.../attachment-processing.ts` | 15 | `SUPPORTED_IMAGE_MEDIA_TYPES` — backend allow-list (missing `image/jpg`) |
| `src/backend/.../attachment-processing.ts` | 37-44 | `UnsupportedImageTypeError` — source of the exact error text, including `(unknown)` fallback |
| `src/backend/.../attachment-processing.ts` | 81-89 | `validateImageMediaType` — re-validates `attachment.type` string, no byte inspection |

---

## Recommended Fix

Stop trusting reported MIME strings; get the image into a supported format by whatever path is most robust for the surface we're on; keep the server's own validation honest. The key design constraint that shapes everything below:

> ### ⚠️ Constraint: the browser cannot decode TIFF
>
> The obvious client-side transcode — `createImageBitmap(blob)` → `<canvas>` → `canvas.toBlob('image/png')` — **does not work for the actual reported case.** Neither `<img>`, `createImageBitmap`, nor `<canvas>` supports TIFF in Chromium (and therefore not in the Electron renderer either). Since the macOS screenshot-to-clipboard case is precisely a TIFF, a client-side canvas transcode would *throw* on exactly the input we need to handle. Canvas transcode only helps for a *mislabeled but browser-decodable* image (a real PNG/JPEG reported with a bad/empty type). So:
> - **Detecting** the format client-side is easy and library-optional (see below).
> - **Converting TIFF→PNG** requires either a non-canvas decoder (a JS/WASM TIFF library) or doing the work off the browser (Electron main process, or the backend).
>
> This constraint is why the fix is organized around *where the conversion happens*, not just *how we detect the type*.

### On detection: use a commodity approach, don't hand-roll a decoder

For identifying the format from bytes, the commodity option is [`file-type`](https://github.com/sindresorhus/file-type) (`fileTypeFromBlob` / `fileTypeFromBuffer`), which works in both the Vite frontend and the Node backend and recognizes TIFF/BMP/PNG/JPEG/GIF/WebP out of the box. That said, detection for exactly six formats is ~15 lines of magic-number comparison (PNG `89 50 4E 47`, JPEG `FF D8 FF`, GIF `47 49 46 38`, WebP `52 49 46 46…57 45 42 50`, TIFF `49 49 2A 00` / `4D 4D 00 2A`, BMP `42 4D`), so a dependency here is optional. **The thing we must never hand-roll is a TIFF *decoder*** — that is what the library options below are for. Detection alone does not fix the bug; conversion does.

The options below are ordered by preference. Prototype Option A first; it may resolve the bug with no image library at all.

### Option A (try first): Let the OS/browser hand us PNG directly

The most robust and lowest-dependency fix is to not sniff or transcode ourselves at all, but to read the clipboard through a channel that already exposes a PNG representation. macOS holds the screenshot on the pasteboard in multiple flavors; the legacy `paste`-event `DataTransferItem` path the code uses today just happens to surface the TIFF one.

- **Electron build:** bridge `clipboard.readImage()` from the main process (it returns a `NativeImage` with a reliable `.toPNG()`), exposed over the existing preload IPC. The OS performs the conversion; we ship zero image libraries. Note: `electron/preload/index.ts` currently exposes only `showOpenDialog` and window-focus IPC, so this is a small, additive bridge.
- **Web build:** prefer the async Clipboard API (`navigator.clipboard.read()` → iterate `ClipboardItem.types`) over the `paste`-event `DataTransferItem` path. The async API frequently exposes an `image/png` representation of the same clipboard entry even when the legacy path only offers TIFF. (Caveat: `navigator.clipboard.read()` requires a secure context and may prompt for clipboard-read permission; keep the existing paste path as a fallback.)

If either channel yields PNG, we're done — no detection, no transcode, no new dependency. This is worth a spike before committing to B/C.

### Option B (robust fallback): Normalize on the backend with `sharp`

If a raw TIFF still reaches us (async clipboard didn't offer PNG, non-Electron, older browser), do the conversion server-side. [`sharp`](https://github.com/lovell/sharp) (libvips) both detects *and* transcodes TIFF/BMP/whatever → PNG in a single call, and would become the single normalization point — the client sends raw bytes, the backend guarantees a supported format downstream (which also subsumes Layer "unify the allow-list" and the backend-hardening layer below). Trade-off to weigh: `sharp` is a **native dependency** with prebuilt binaries that must load correctly in *both* the plain Node server and the packaged Electron backend (correct ABI/platform binaries in the build), which is the main integration cost. Payload size is a non-issue — raw TIFF over the wire stays under the existing 10MB cap.

### Option C (client-side, no native dep): `file-type` + a JS TIFF decoder

If we specifically want the conversion to happen before anything leaves the browser and want to avoid a native backend dependency: detect with `file-type` (or the inline magic-number check), and for TIFF decode with a pure-JS decoder such as [`utif`](https://github.com/photopea/UTIF.js) → draw to canvas → `toBlob('image/png')`. For genuinely browser-decodable-but-mislabeled inputs (real PNG/JPEG with a bad type), the plain `createImageBitmap` → canvas round-trip is enough and no decoder is needed. Downside: most moving parts, and it pulls a TIFF decoder into the frontend bundle.

### Regardless of A/B/C: two cleanups that stand on their own

1. **Unify the allow-list.** Move `SUPPORTED_IMAGE_TYPES` into a module importable by both client and backend (e.g. `src/shared/`) and have `attachment-processing.ts` import it instead of maintaining its own `SUPPORTED_IMAGE_MEDIA_TYPES`. This removes the `image/jpg` drift (Root Cause 2) independent of the format-handling work. (Subsumed automatically if Option B makes the backend the sole normalizer.)
2. **Backend defense-in-depth.** The server must not fully trust client-supplied `attachment.type` (a buggy/malicious client can still send an arbitrary string). Validate the decoded base64 payload's magic bytes against the shared format list, independent of the declared `type`. This is a correctness/robustness fix — a mislabeled-but-valid image could otherwise be forwarded to Claude's vision API with an incorrect declared media type — not primarily a security fix, since these are inert raster formats. (If Option B is adopted, `sharp` already establishes ground truth here.)

### Better failure messaging (all options)

When an image genuinely can't be read/converted, replace the raw backend-error surfacing and the generic "Could not paste image from clipboard" toast with something actionable, e.g. *"Couldn't read that image from the clipboard. Try dragging the file in instead."*

---

## Implementation Plan

### Phase 0: Spike Option A (do this first — may obviate Phases 1–2)
1. Prototype the Electron `clipboard.readImage().toPNG()` bridge and, separately, a `navigator.clipboard.read()` read path; on a real macOS screenshot, log the `types`/representations each surfaces.
2. Decide based on results: if either reliably yields PNG, implement that as the primary fix and skip to the cleanups. If not, proceed to Phase 1 with Option B (preferred) or C.

### Phase 1: Format normalization fallback (Option B unless the native dep is unacceptable, then C)
- **Option B:** add `sharp` to the backend; on attachment ingest, sniff + transcode any non-supported-but-decodable image to PNG, updating `type` accordingly, before `validateImageMediaType`. Verify `sharp` binaries load in both the server and packaged Electron builds.
- **Option C:** add a detection helper (`file-type` or inline magic numbers) + `utif` for TIFF; in `processClipboardImageItem` (`paste-utils.ts`) and `fileToAttachment` (`image-utils.ts`), sniff bytes, transcode TIFF/BMP → PNG (utif/canvas), and set `type: 'image/png'`. Use the plain `createImageBitmap`→canvas path for mislabeled-but-decodable inputs.

### Phase 2: Shared allow-list + backend hardening
3. Extract `SUPPORTED_IMAGE_TYPES` to `src/shared/`; import it in both `image-utils.ts` and `attachment-processing.ts`, removing the `image/jpg` drift. (Skip if Option B made the backend the sole normalizer.)
4. Add magic-byte validation to `validateImageMediaType` in `attachment-processing.ts`, validating decoded payload bytes rather than trusting `attachment.type` alone. (Skip if covered by `sharp`.)

### Phase 3: Failure messaging
5. Replace the raw backend-error surfacing / generic clipboard toast with an actionable message for genuinely undecodable data.

### Testing
- If Option B/C: unit tests for the detector against fixture byte arrays per format; unit test converting a TIFF fixture → assert a PNG attachment (`type: 'image/png'`) is produced.
- If Option A: an integration/manual check that the chosen clipboard channel yields PNG for a real macOS screenshot (hard to unit-test the OS pasteboard; rely on manual verification + a thin unit test around the bridge/parse logic).
- Backend unit test: `validateAttachment` accepts a correctly-typed attachment and rejects one whose sniffed bytes don't match any supported format, independent of the declared `type`.
- Manual verification on macOS across surfaces: Cmd+Ctrl+Shift+4 → paste into the create-task box **and** the chat input, in **both** the Electron app and the web build; confirm the image attaches without error.

---

## Implementation status (Option A)

Implemented as the fallback path in the existing shared paste pipeline, so it covers both the create-task form (`InlineWorkspaceForm`) and the session chat input (`ChatInput`) at once.

**New client module — `src/lib/clipboard-image.ts`**
- `getClipboardImageBlob()` asks the platform for the current clipboard image as a Blob: tries the Electron main-process bridge first (no permission prompt), then the web async Clipboard API (`navigator.clipboard.read()` → `image/png`, which Chromium normalizes from the pasteboard's TIFF). Returns `null` when unavailable/denied so callers degrade gracefully.

**Paste pipeline — `src/lib/paste-utils.ts`**
- Replaced the narrow `hasClipboardImages` gate with `clipboardEventHasImageItem`, which also matches `image/tiff` and empty-typed file items so a screenshot paste enters the image path instead of being treated as text.
- `getClipboardImages` now extracts directly-usable supported items first; only if none produced an attachment does it call `getClipboardImageBlob()` and build a PNG attachment (`processClipboardImageBlob`). Ordering matters: the async clipboard read is the first `await` in the fallback case, preserving the paste's transient user activation.
- Clearer failure toast in `use-paste-drop-handler.ts` when nothing usable can be read.

**Electron bridge**
- `electron/main/lifecycle.ts`: new `clipboard:readImagePng` IPC handler returning base64 PNG (or `null` when empty); added a `clipboard` dependency (`ClipboardLike`) to `ElectronLifecycleDependencies` and generalized `IpcMainLike.handle`.
- `electron/main/index.ts`: passes the real Electron `clipboard`.
- `electron/preload/index.ts`: exposes `readClipboardImageAsPng()` on `electronAPI`.
- `src/types/electron.d.ts`: typed the new method.

**Tests**
- `src/lib/paste-utils.test.ts`: TIFF-item → platform-PNG fallback produces an `image/png` attachment; supported items skip the fallback; `clipboardEventHasImageItem` matches TIFF/empty file items and ignores text.
- `electron/main/lifecycle.test.ts`: `clipboard:readImagePng` returns base64 for a non-empty image and `null` when empty.

`pnpm typecheck`, `pnpm check` (Biome, service registry, dependency boundaries), and the touched test files all pass.

**Not yet done / follow-ups (unchanged from the plan):** the standalone cleanups — unifying the client/backend allow-list (Root Cause 2) and backend magic-byte defense-in-depth — are independent of Option A and still worth doing. Options B/C remain the documented fallback if real-world testing shows a raw image still reaching the backend. **Manual verification on a real macOS machine (Electron app + web build) is still required** — the OS pasteboard can't be exercised in the unit-test environment.
