# VP8 Partition Boundary Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject VP8 keyframes whose declared first partition exceeds the bytes available after the full ten-byte keyframe header.

**Architecture:** Preserve the existing attachment-validation and WebP parsing boundaries. Exercise the public `validateAttachment` behavior with a test-local RIFF/VP8 fixture, then correct the private capacity calculation by changing the header allowance from three bytes to ten.

**Tech Stack:** TypeScript, Node.js `Buffer`, Vitest

## Global Constraints

- Keep `inspectSupportedImageFormat` and `validateAttachment` interfaces unchanged.
- Add no runtime dependencies.
- Do not change validation for PNG, JPEG, GIF, VP8L, or animated WebP layout.
- Preserve the existing permanent-error behavior for structurally invalid supported images.

---

### Task 1: Correct the VP8 first-partition boundary

**Files:**

- Modify: `src/backend/services/session/service/chat/chat-message-handlers/image-format-validation.ts:424`
- Test: `src/backend/services/session/service/chat/chat-message-handlers/attachment-processing.test.ts`

**Interfaces:**

- Consumes: `validateAttachment(attachment: MessageAttachment): void`
- Produces: unchanged public APIs; malformed VP8 attachments now throw `PermanentAttachmentError`

- [ ] **Step 1: Add a test-local malformed WebP builder**

Add this helper near the existing image fixture helpers:

```typescript
function createVp8WebpBase64(firstPartitionLength: number, partitionLength: number): string {
  const vp8Data = Buffer.alloc(10 + partitionLength);
  vp8Data.writeUIntLE((firstPartitionLength << 5) | 0x10, 0, 3);
  Buffer.from([0x9d, 0x01, 0x2a]).copy(vp8Data, 3);
  vp8Data.writeUInt16LE(1, 6);
  vp8Data.writeUInt16LE(1, 8);

  const webp = Buffer.alloc(20 + vp8Data.length);
  webp.write('RIFF', 0, 'ascii');
  webp.writeUInt32LE(webp.length - 8, 4);
  webp.write('WEBP', 8, 'ascii');
  webp.write('VP8 ', 12, 'ascii');
  webp.writeUInt32LE(vp8Data.length, 16);
  vp8Data.copy(webp, 20);
  return webp.toString('base64');
}
```

- [ ] **Step 2: Write the failing regression test**

Add this case to the `validateAttachment` suite:

```typescript
it('should reject a VP8 first partition that exceeds the bytes after its keyframe header', () => {
  const attachment = createImageAttachment({
    data: createVp8WebpBase64(14, 10),
  });

  expect(() => validateAttachment(attachment)).toThrow(PermanentAttachmentError);
});
```

This test catches the production mutation `dataLength - 10` back to
`dataLength - 3`.

- [ ] **Step 3: Run the focused test and verify the regression fails**

Run:

```bash
pnpm test src/backend/services/session/service/chat/chat-message-handlers/attachment-processing.test.ts
```

Expected: the new test fails because `validateAttachment` does not throw.

- [ ] **Step 4: Apply the minimal production fix**

Change the VP8 keyframe predicate to:

```typescript
firstPartitionLength <= dataLength - 10 &&
```

- [ ] **Step 5: Run the focused test and verify it passes**

Run:

```bash
pnpm test src/backend/services/session/service/chat/chat-message-handlers/attachment-processing.test.ts
```

Expected: all attachment-processing tests pass.

- [ ] **Step 6: Run complete repository verification**

Run:

```bash
pnpm typecheck && pnpm check:fix && pnpm test && pnpm build
```

Expected: every command exits successfully.

- [ ] **Step 7: Review and commit**

Review `git diff origin/main`, stage only the design, plan, validator, and
test files, then commit with:

```bash
git commit -m "Fix VP8 partition boundary validation (#2094)"
```

- [ ] **Step 8: Publish the pull request**

Push the current branch, create the issue-closing PR with the required Factory
Factory signature, and verify the resulting PR URL.
