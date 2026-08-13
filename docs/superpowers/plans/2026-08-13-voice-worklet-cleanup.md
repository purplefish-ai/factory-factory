# Voice Worklet Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent queued AudioWorklet messages from invoking speech callbacks after voice capture cleanup.

**Architecture:** Keep resource disposal centralized in `disposeCaptureResources`. Detach the worklet port handler before closing and disconnecting, mirroring the existing WebSocket lifecycle boundary, and protect it with a focused unit regression test.

**Tech Stack:** TypeScript, React voice feature, Web Audio API, Vitest, pnpm.

## Global Constraints

- Use pnpm, never npm or yarn.
- Keep the change scoped to AudioWorklet cleanup and its co-located regression test.
- Follow test-driven development: observe the regression test fail before changing production code.
- Run `pnpm check:fix`, `pnpm typecheck`, `pnpm test`, `pnpm check`, and `pnpm build` before handoff.
- Close GitHub issue #2164 from the pull request body.

---

### Task 1: Detach the AudioWorklet message handler during cleanup

**Files:**
- Modify: `src/client/features/voice/use-mic-capture.ts`
- Test: `src/client/features/voice/use-mic-capture.test.ts`

**Interfaces:**
- Consumes: `CaptureResources` and the existing `AudioWorkletNode.port.onmessage` lifecycle.
- Produces: exported `disposeCaptureResources(resources: CaptureResources): void`, which clears `port.onmessage` before closing and disconnecting a present worklet node.

- [ ] **Step 1: Write the failing regression test**

```typescript
it('detaches queued worklet messages before closing capture resources', () => {
  const onSpeechDetected = vi.fn();
  const port = { onmessage: onSpeechDetected, close: vi.fn() };
  const workletNode = {
    port,
    disconnect: vi.fn(),
  } as unknown as AudioWorkletNode;

  disposeCaptureResources({
    workletNode,
    silentGain: null,
    audioContext: null,
    mediaStream: null,
    socket: null,
  });
  port.onmessage?.({ data: new ArrayBuffer(0) } as MessageEvent<ArrayBuffer>);

  expect(onSpeechDetected).not.toHaveBeenCalled();
  expect(port.close).toHaveBeenCalledOnce();
  expect(workletNode.disconnect).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the focused test and verify the new test fails because the handler remains installed**

Run: `pnpm test src/client/features/voice/use-mic-capture.test.ts`

Expected: FAIL because `onSpeechDetected` is called after disposal.

- [ ] **Step 3: Implement the minimal cleanup fix**

```typescript
export function disposeCaptureResources(resources: CaptureResources): void {
  const { workletNode } = resources;
  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.port.close();
    workletNode.disconnect();
  }
  // Preserve the remainder of the existing cleanup behavior.
}
```

- [ ] **Step 4: Re-run the focused test and verify it passes**

Run: `pnpm test src/client/features/voice/use-mic-capture.test.ts`

Expected: PASS with all tests in the file green.

- [ ] **Step 5: Run repository verification**

Run in order:

```bash
pnpm check:fix
pnpm typecheck
pnpm test
pnpm check
pnpm build
```

Expected: every command exits successfully.

- [ ] **Step 6: Commit the focused fix**

```bash
git add src/client/features/voice/use-mic-capture.ts src/client/features/voice/use-mic-capture.test.ts
git commit -m "Fix queued voice worklet callbacks (#2164)"
```

- [ ] **Step 7: Review, publish, and open the pull request**

Review `git diff origin/main`, push the current issue branch, and create a pull
request whose body summarizes the cleanup race, lists verification evidence,
includes `Closes #2164`, and ends with the required Factory Factory signature.
