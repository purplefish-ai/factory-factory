# Chat Error Order Namespace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent locally rendered WebSocket errors from claiming backend transcript orders and blocking live assistant text.

**Architecture:** Assign local transport errors a negative sentinel order and compare negative local orders as the live renderer tail. Rebuild the agent order lookup from non-negative backend-owned orders only so the first assistant delta at the next backend order creates and indexes its own message without trimming away the local error.

**Tech Stack:** TypeScript, React reducer state, Vitest, Biome

## Global Constraints

- Change only the client reducer behavior required for issue #1984.
- Preserve the stable message-ID guard for existing backend messages.
- Preserve visible error rendering, loading-status recovery, transcript trimming, and normal backend ordering.
- Retain newly arrived local errors and assistant deltas at the renderer transcript limit.
- Use a failing regression test before changing production code.
- Run `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build` before publishing.

---

### Task 1: Reproduce the Error and Assistant Delta Collision

**Files:**
- Modify: `src/components/chat/chat-reducer.test.ts`

**Interfaces:**
- Consumes: `chatReducer(state: ChatState, action: ChatAction): ChatState`
- Produces: regression coverage for replay → local error → first assistant delta

- [ ] **Step 1: Add the failing reducer regression test**

In the `WS_ASSISTANT_TEXT_DELTA action` describe block, replay eight backend assistant messages,
dispatch `WS_ERROR`, then dispatch offset-zero text for `messageId: 'session-1-8'` at order 8.
Assert:

```typescript
expect(state.messages.find((message) => message.message?.type === 'error')?.order).toBe(-1);
expect(state.agentMessageOrderToIndex.has(-1)).toBe(false);
expect(state.messages.find((message) => message.id === 'session-1-8')).toMatchObject({
  order: 8,
  message: {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Visible response' }] },
  },
});
expect(state.agentMessageOrderToIndex.get(8)).toBe(
  state.messages.findIndex((message) => message.id === 'session-1-8')
);
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
pnpm exec vitest run src/components/chat/chat-reducer.test.ts \
  -t "keeps assistant text visible when an error arrives at the next backend order"
```

Expected: the error has order 8, the negative-order assertions fail, and no assistant message with
ID `session-1-8` exists.

- [ ] **Step 3: Commit the regression test with the implementation**

Keep the failing test unstaged until Task 2 is green so no intentionally failing commit is created.

### Task 2: Separate Local and Backend Order Namespaces

**Files:**
- Modify: `src/components/chat/reducer/slices/messages/transport.ts`
- Modify: `src/components/chat/reducer/helpers.ts`
- Modify: `src/shared/acp-protocol/protocol/renderer-window.ts`
- Test: `src/components/chat/chat-reducer.test.ts`
- Test: `src/shared/acp-protocol/protocol.test.ts`

**Interfaces:**
- Produces: module-local `ERROR_MESSAGE_ORDER` with value `-1`
- Produces: `compareTranscriptMessageOrder(left: ChatMessage, right: ChatMessage): number`
- Preserves: `agentMessageOrderToIndex: Map<number, number>` for backend-owned non-negative orders

- [ ] **Step 1: Assign local errors the negative sentinel**

Add the constant beside the transport imports and replace the client maximum-order calculation:

```typescript
const ERROR_MESSAGE_ORDER = -1;

// ...
order: ERROR_MESSAGE_ORDER,
```

- [ ] **Step 2: Exclude negative orders from the agent lookup**

Narrow `buildAgentMessageOrderToIndex` to backend-owned orders:

```typescript
if (message.source === 'agent' && message.order >= 0) {
  orderToIndex.set(message.order, index);
}
```

- [ ] **Step 3: Keep negative local messages at the live renderer tail**

Export one comparator from `renderer-window.ts` and use it both for renderer normalization and the
client's binary insertion:

```typescript
function rendererSortOrder(message: ChatMessage): number {
  return message.order < 0 ? Number.POSITIVE_INFINITY : message.order;
}

export function compareTranscriptMessageOrder(left: ChatMessage, right: ChatMessage): number {
  const leftOrder = rendererSortOrder(left);
  const rightOrder = rendererSortOrder(right);
  if (leftOrder === rightOrder) {
    return 0;
  }
  return leftOrder < rightOrder ? -1 : 1;
}
```

This maintains a shared sorted-array invariant: backend orders remain ascending and negative local
messages remain after them in stable arrival order. Add a protocol unit test requiring two negative
local orders to compare as equal rather than producing `NaN`.

- [ ] **Step 4: Add and run the renderer-limit regression**

Replay `DEFAULT_RENDERER_TRANSCRIPT_LIMIT` backend messages, then dispatch `WS_ERROR` and the first
assistant delta at the next backend order. Require the messages array to remain capped, the error to
remain at the tail, the assistant to remain visible, and only the assistant's non-negative order to
be indexed.

```bash
pnpm exec vitest run src/components/chat/chat-reducer.test.ts \
  -t "retains the error and assistant delta at the renderer transcript limit"
```

Expected before the comparator change: FAIL because the error is trimmed. Expected after the
comparator change: PASS.

- [ ] **Step 5: Run the original focused test and verify GREEN**

```bash
pnpm exec vitest run src/components/chat/chat-reducer.test.ts \
  -t "keeps assistant text visible when an error arrives at the next backend order"
```

Expected: one test passes and the assistant message is present at backend order 8.

- [ ] **Step 6: Run the complete reducer and protocol test files**

```bash
pnpm exec vitest run src/components/chat/chat-reducer.test.ts \
  src/shared/acp-protocol/protocol.test.ts
```

Expected: all reducer and renderer protocol tests pass.

- [ ] **Step 7: Commit the focused fix**

```bash
git add src/components/chat/chat-reducer.test.ts \
  src/components/chat/reducer/helpers.ts \
  src/components/chat/reducer/slices/messages/transport.ts \
  src/shared/acp-protocol/protocol.test.ts \
  src/shared/acp-protocol/protocol/renderer-window.ts
git commit -m "Fix chat error order collisions (#1984)"
```

### Task 3: Verify, Review, and Publish

**Files:**
- Review: all files changed from `origin/main`
- Create temporarily: `/tmp/pr-body.md`

**Interfaces:**
- Produces: pushed branch and GitHub pull request closing issue #1984

- [ ] **Step 1: Run the required verification chain**

```bash
pnpm typecheck && pnpm check:fix && pnpm test && pnpm build
```

Expected: every command exits 0. Review and explicitly stage any formatting changes made by
`check:fix`.

- [ ] **Step 2: Review the complete diff and worktree**

```bash
git diff origin/main
git status -sb
```

Confirm there are no debug logs, unrelated edits, or uncommitted scoped changes. This reducer-only
behavior change does not require a UI screenshot because it introduces no new or changed visual
state.

- [ ] **Step 3: Commit verification-induced changes if present**

Stage only scoped files and use a short imperative commit message under 72 characters. Do not create
an empty commit when verification changed nothing.

- [ ] **Step 4: Push the current branch**

```bash
git push -u origin HEAD
```

- [ ] **Step 5: Create and verify the pull request**

Write `/tmp/pr-body.md` with summary, changes, testing, `Closes #1984`, and the required Factory
Factory signature, then run:

```bash
gh pr create --title "Fix #1984: Prevent chat error order collisions" \
  --body-file /tmp/pr-body.md
gh pr view --web
gh pr view --json url
```

Expected: GitHub returns the created pull request URL.
