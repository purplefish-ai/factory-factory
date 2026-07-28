# Backend Image Media-Type Normalization Implementation Plan

**Goal:** Deliver valid PNG, JPEG, GIF, and WebP attachments even when client MIME metadata is empty or incorrect.

**Architecture:** Keep image handling inside the session capsule's attachment-processing boundary. Decode validated base64 once per processing pass, detect a supported signature, and return an immutable attachment copy carrying the canonical ACP media type.

**Tech Stack:** TypeScript, Node.js `Buffer`, Vitest

## Global Constraints

- Do not add support for new image formats or transcode unsupported formats.
- Do not add a runtime dependency.
- Keep text attachment behavior unchanged.
- Treat unsupported or corrupt image bytes as permanent attachment errors.

---

### Task 1: Normalize image media types from bytes

**Files:**

- Modify: `src/backend/services/session/service/chat/chat-message-handlers/attachment-processing.ts`
- Test: `src/backend/services/session/service/chat/chat-message-handlers/attachment-processing.test.ts`

**Interfaces:**

- Consumes: `MessageAttachment.data`, `MessageAttachment.type`, and `resolveAttachmentContentType`.
- Produces: `processAttachmentsAndBuildContent()` output whose ACP image blocks use canonical detected media types.

- [ ] **Step 1: Write the failing regression tests**

Add table-driven assertions to `attachment-processing.test.ts` using literal base64 fixtures for PNG, JPEG, GIF, and WebP. Assert that empty, incorrect, and non-canonical declared types are replaced by the detected canonical type in the ACP content returned by `processAttachmentsAndBuildContent`.

Add a corrupt-image assertion:

```typescript
expect(() =>
  processAttachmentsAndBuildContent('Message', [
    createImageAttachment({
      type: 'image/png',
      data: Buffer.from('not an image').toString('base64'),
    }),
  ])
).toThrow(PermanentAttachmentError);
```

- [ ] **Step 2: Run the focused test and verify the regression fails**

Run:

```bash
pnpm test src/backend/services/session/service/chat/chat-message-handlers/attachment-processing.test.ts
```

Expected: the empty-type PNG case fails with `UnsupportedImageTypeError`, proving the affected session behavior is reproduced.

- [ ] **Step 3: Implement byte-signature detection and immutable normalization**

In `attachment-processing.ts`, add a private detector returning:

```typescript
type SupportedImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
```

Recognize PNG's eight-byte signature, JPEG's leading `FF D8 FF`, GIF's `GIF87a`/`GIF89a`, and WebP's `RIFF....WEBP` markers.

Replace declared-type validation with a normalization operation that:

```typescript
const detectedType = detectSupportedImageMediaType(
  Buffer.from(stripBase64LineEndings(attachment.data), 'base64')
);
if (!detectedType) {
  throw new PermanentAttachmentError(
    `Attachment "${attachment.name}" does not contain supported image data`
  );
}
return { ...attachment, type: detectedType };
```

Keep `validateAttachment()` as a validation-only public API by invoking the same normalization and discarding its returned copy. Normalize the attachment array inside `processAttachmentsAndBuildContent()` before categorization and ACP content construction.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
pnpm test src/backend/services/session/service/chat/chat-message-handlers/attachment-processing.test.ts
```

Expected: all attachment-processing tests pass.

- [ ] **Step 5: Run repository verification**

Run:

```bash
pnpm typecheck
pnpm check
pnpm test
```

Expected: each command exits successfully with no test failures or guardrail violations.

- [ ] **Step 6: Commit the implementation**

Stage the spec, plan, production change, and tests, then commit with:

```bash
git commit -m "Normalize image types from attachment bytes"
```
