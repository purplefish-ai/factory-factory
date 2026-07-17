# Hidden Workspace Log Throttling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve bounded log history and accurate connection indicators while throttling React output and scroll work to the visible workspace log stream.

**Architecture:** Store incoming text in an array-backed `RollingOutputBuffer` outside React state. Give `useLogStream` explicit visibility, immediately snapshot the buffer when shown, throttle live visible snapshots to 100 ms, and scroll once per committed visible snapshot with `requestAnimationFrame`.

**Tech Stack:** TypeScript, React 19 hooks, Zod, Vitest, jsdom

## Global Constraints

- Keep both `/dev-logs` and `/post-run-logs` WebSocket connections mounted.
- Preserve the 512 KiB workspace-log cap and `[Earlier output truncated]\n` marker semantics.
- Hidden traffic must not update presentation state or schedule scrolling per chunk.
- Connection/disconnection indicator state must remain current while hidden.
- Do not reconnect or lose messages when switching bottom-panel tabs.

---

### Task 1: Add an array-backed rolling output buffer

**Files:**
- Modify: `src/components/workspace/rolling-output.ts`
- Test: `src/components/workspace/rolling-output.test.ts`

**Interfaces:**
- Consumes: `{ maxChars: number; truncationMarker: string }`
- Produces: `RollingOutputBuffer.append(next: string): void` and `RollingOutputBuffer.toString(): string`

- [ ] **Step 1: Write failing buffer tests**

Add tests that construct `new RollingOutputBuffer(options)`, append multiple
chunks, and assert that `toString()` preserves sub-cap output, retains only the
newest capped body with one marker after overflow, handles an oversized chunk,
and returns an empty string at zero capacity.

- [ ] **Step 2: Verify the new tests fail**

Run: `pnpm exec vitest run src/components/workspace/rolling-output.test.ts`

Expected: FAIL because `RollingOutputBuffer` is not exported.

- [ ] **Step 3: Implement the minimal mutable buffer**

Add a class that stores string chunks, a head index, retained character count,
and a truncation flag. On append, detect the first overflow, trim leading chunks
to the correct body capacity, and compact consumed array slots on append once
the consumed-slot count reaches a threshold relative to the retained chunks.
`toString()` must join only retained chunks and prepend the bounded marker only
after truncation.

- [ ] **Step 4: Verify buffer behavior**

Run: `pnpm exec vitest run src/components/workspace/rolling-output.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the buffer**

```bash
git add src/components/workspace/rolling-output.ts src/components/workspace/rolling-output.test.ts
git commit -m "Add chunked workspace log buffer (#1948)"
```

### Task 2: Make log presentation visibility-aware and throttled

**Files:**
- Modify: `src/components/workspace/use-log-stream.ts`
- Test: `src/components/workspace/use-log-stream.test.tsx`

**Interfaces:**
- Consumes: `useLogStream(endpoint: LogStreamEndpoint, workspaceId: string, isVisible: boolean)` and `RollingOutputBuffer`
- Produces: unchanged `UseLogStreamResult` shape with throttled `output`, live `connected`/`hasDisconnected`, and `outputEndRef`

- [ ] **Step 1: Write failing visibility and burst tests**

Update the harness with an `isVisible` prop and render counter. Add fake-timer
tests proving hidden bursts do not rerender output or scroll; becoming visible
hydrates buffered output immediately; visible bursts commit once after 100 ms;
disconnect/reconnect announcements and indicator state survive a hidden period;
and invalid messages remain ignored.

- [ ] **Step 2: Write failing cleanup and scroll tests**

Stub `requestAnimationFrame`, `cancelAnimationFrame`, and `scrollIntoView`. Assert
that one visible output commit produces one frame-aligned scroll and that hiding
or unmounting cancels pending flush/frame callbacks.

- [ ] **Step 3: Verify the hook tests fail**

Run: `pnpm exec vitest run src/components/workspace/use-log-stream.test.tsx`

Expected: FAIL because the hook has no visibility input and still updates and
scrolls once per chunk.

- [ ] **Step 4: Implement visibility-aware buffering**

Create one `RollingOutputBuffer` per endpoint/workspace identity. Append all
valid transport and lifecycle text to it. Track current visibility in a ref;
schedule at most one 100 ms flush only while visible; immediately snapshot in a
layout effect when shown; and cancel flush timers on hide, identity change, and
unmount.

- [ ] **Step 5: Implement frame-aligned committed-output scrolling**

Replace chunk-level `setTimeout(..., 10)` calls with an effect keyed by visible,
non-empty `output`. Schedule one animation frame, cancel the prior frame during
effect cleanup, and scroll the end ref inside that frame.

- [ ] **Step 6: Verify the hook tests pass**

Run: `pnpm exec vitest run src/components/workspace/use-log-stream.test.tsx`

Expected: PASS with no timer or `act` warnings.

- [ ] **Step 7: Commit the hook**

```bash
git add src/components/workspace/use-log-stream.ts src/components/workspace/use-log-stream.test.tsx
git commit -m "Throttle workspace log presentation (#1948)"
```

### Task 3: Connect active-tab visibility and verify the feature

**Files:**
- Modify: `src/components/workspace/right-panel.tsx`

**Interfaces:**
- Consumes: `activeBottomTab` and the new `useLogStream(..., isVisible)` signature
- Produces: exactly one visible log-stream presentation subscription at a time

- [ ] **Step 1: Pass exact tab visibility to each hook**

Call the dev hook with `activeBottomTab === 'dev-logs'` and the post-run hook
with `activeBottomTab === 'post-run-logs'`. Keep both calls unconditional so the
connections and status indicators remain mounted.

- [ ] **Step 2: Run focused regression tests**

Run: `pnpm exec vitest run src/components/workspace/rolling-output.test.ts src/components/workspace/use-log-stream.test.tsx`

Expected: PASS.

- [ ] **Step 3: Commit the integration**

```bash
git add src/components/workspace/right-panel.tsx
git commit -m "Activate log rendering by selected tab (#1948)"
```

### Task 4: Full verification, review, and pull request

**Files:**
- Review: all files changed from `origin/main`
- Optionally create: `.factory-factory/screenshots/<descriptive-name>.png` only if a screenshot can demonstrate the behavior

**Interfaces:**
- Consumes: completed implementation and test commits
- Produces: a clean pushed branch and GitHub pull request closing #1948

- [ ] **Step 1: Run required verification**

Run: `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`

Expected: all commands exit 0. Review and commit any intentional formatting
changes made by `check:fix`.

- [ ] **Step 2: Review the complete diff**

Run: `git diff origin/main` and `git status --short`.

Expected: no debug output, commented code, unrelated edits, or uncommitted files.

- [ ] **Step 3: Decide screenshot applicability**

Because the change intentionally preserves visible appearance and changes only
render frequency while a stream is hidden, record screenshot capture as not
applicable unless manual testing reveals a meaningful visible state to show.

- [ ] **Step 4: Push and create the PR**

Push with `git push -u origin HEAD`. Write `/tmp/pr-body.md` with Summary,
Changes, Testing, `Closes #1948`, the required horizontal rule, and Factory
Factory signature. Create with:

```bash
gh pr create --title "Fix #1948: Throttle hidden workspace logs" --body-file /tmp/pr-body.md
```

- [ ] **Step 5: Verify and report the PR URL**

Run: `gh pr view --json url,title,state` and confirm the returned PR is open.
