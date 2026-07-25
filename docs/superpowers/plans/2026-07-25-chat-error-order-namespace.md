# Chat Error Order Namespace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent locally rendered WebSocket errors from claiming backend transcript orders and blocking live assistant text.

**Architecture:** Assign local transport errors a negative sentinel order, while retaining them in the renderer transcript. Rebuild the agent order lookup from non-negative backend-owned orders only so the first assistant delta at the next backend order creates and indexes its own message.

**Tech Stack:** TypeScript, React reducer state, Vitest, Biome

## Global Constraints

- Change only the client reducer behavior required for issue #1984.
- Preserve the stable message-ID guard for existing backend messages.
- Preserve visible error rendering, loading-status recovery, transcript trimming, and normal backend ordering.
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
- Test: `src/components/chat/chat-reducer.test.ts`

**Interfaces:**
- Produces: module-local `ERROR_MESSAGE_ORDER` with value `-1`
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

- [ ] **Step 3: Run the focused test and verify GREEN**

```bash
pnpm exec vitest run src/components/chat/chat-reducer.test.ts \
  -t "keeps assistant text visible when an error arrives at the next backend order"
```

Expected: one test passes and the assistant message is present at backend order 8.

- [ ] **Step 4: Run the complete reducer test file**

```bash
pnpm exec vitest run src/components/chat/chat-reducer.test.ts
```

Expected: all reducer tests pass.

- [ ] **Step 5: Commit the focused fix**

```bash
git add src/components/chat/chat-reducer.test.ts \
  src/components/chat/reducer/helpers.ts \
  src/components/chat/reducer/slices/messages/transport.ts
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
