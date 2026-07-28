# PR 2056 Dispatch Failure Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve generic ACP dispatch failures across reconnects and reset provider-busy backoff after a terminal failure.

**Architecture:** Keep the existing short-lived in-memory terminal-message replay mechanism and extend its records to describe either `REJECTED` or `FAILED` states plus an optional recovery payload. Route generic dispatch failures through a `SessionDomainService.failMessage` boundary that records and publishes the same event, while clearing the handler's busy-turn attempt counter when that message terminates.

**Tech Stack:** TypeScript, Vitest, ACP WebSocket message-state events, in-memory session store

## Global Constraints

- Keep changes limited to PR 2056's dispatch failure behavior.
- Preserve provider-busy requeue/backoff behavior.
- Preserve the existing 60-second replay TTL and 100-record cap.
- Do not reply to or resolve GitHub review threads.

---

### Task 1: Replay generic dispatch failures

**Files:**
- Modify: `src/backend/services/session/service/store/session-store.types.ts`
- Modify: `src/backend/services/session/service/store/session-replay-builder.ts`
- Test: `src/backend/services/session/service/session-domain.service.test.ts`
- Modify: `src/backend/services/session/service/session-domain.service.ts`
- Test: `src/backend/services/session/service/chat/chat-message-handlers.service.test.ts`
- Modify: `src/backend/services/session/service/chat/chat-message-handlers.service.ts`

**Interfaces:**
- Consumes: `QueuedMessage` and the existing `message_state_changed` WebSocket payload.
- Produces: `SessionDomainService.failMessage(sessionId: string, message: QueuedMessage, errorMessage: string): void`.

- [ ] **Step 1: Write the failing reconnect regression**

Add a `SessionDomainService` test that calls:

```ts
sessionDomainService.failMessage(
  's1',
  {
    id: 'failed-1',
    text: 'retry this draft',
    timestamp: '2026-02-14T00:00:00.000Z',
    attachments: [
      {
        id: 'attachment-1',
        name: 'notes.txt',
        type: 'text/plain',
        size: 11,
        data: 'draft notes',
        contentType: 'text',
      },
    ],
    settings: {
      selectedModel: null,
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  },
  'code -32603: Internal error'
);
```

Subscribe to `s1` and assert that replay contains the literal event:

```ts
{
  type: 'message_state_changed',
  id: 'failed-1',
  newState: 'FAILED',
  errorMessage: 'code -32603: Internal error',
  userMessage: {
    text: 'retry this draft',
    timestamp: '2026-02-14T00:00:00.000Z',
    attachments: [attachment],
    sessionId: 's1',
  },
}
```

- [ ] **Step 2: Run the regression and verify RED**

Run:

```bash
pnpm vitest run src/backend/services/session/service/session-domain.service.test.ts
```

Expected: TypeScript/runtime failure because `failMessage` does not exist.

- [ ] **Step 3: Make terminal replay records state-aware**

Extend `RecentMessageRejection` with:

```ts
state?: MessageState.REJECTED | MessageState.FAILED;
userMessage?: {
  text: string;
  timestamp: string;
  attachments?: MessageAttachment[];
  sessionId?: string;
};
```

Keep omitted `state` backward-compatible as `REJECTED`. Update replay construction to use `rejection.state ?? MessageState.REJECTED` and include `userMessage` when present.

- [ ] **Step 4: Add the domain failure boundary**

Factor the existing TTL/cap logic into a private record-and-publish helper. Keep `rejectMessage` behavior unchanged and implement:

```ts
failMessage(sessionId: string, message: QueuedMessage, errorMessage: string): void
```

The stored and live event must both be `FAILED` and carry the draft text, timestamp, attachments, and source `sessionId`.

- [ ] **Step 5: Run the reconnect regression and verify GREEN**

Run:

```bash
pnpm vitest run src/backend/services/session/service/session-domain.service.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Route dispatch failures through the domain boundary**

Add `failMessage` to the handler test double, update generic-failure expectations to require:

```ts
expect(mockSessionDomainService.failMessage).toHaveBeenCalledWith(
  's1',
  queuedMessage,
  'code -32603: Internal error'
);
```

Run the handler test and verify it fails while production still calls `emitDelta`, then replace the generic failure's direct event publication with:

```ts
sessionDomainService.failMessage(dbSessionId, msg, errorMessage);
```

- [ ] **Step 7: Run focused replay and handler tests**

Run:

```bash
pnpm vitest run src/backend/services/session/service/session-domain.service.test.ts src/backend/services/session/service/store/session-replay-builder.test.ts src/backend/services/session/service/chat/chat-message-handlers.service.test.ts
```

Expected: all tests pass.

### Task 2: Reset stale busy-turn backoff

**Files:**
- Test: `src/backend/services/session/service/chat/chat-message-handlers.service.test.ts`
- Modify: `src/backend/services/session/service/chat/chat-message-handlers.service.ts`

**Interfaces:**
- Consumes: existing `turnInProgressRetryAttempts` session map.
- Produces: a fresh one-second base delay after any generic terminal failure.

- [ ] **Step 1: Write the failing timer regression**

Use fake timers and four send results:

```ts
mockSessionService.sendSessionMessage
  .mockRejectedValueOnce(turnInProgressError)
  .mockRejectedValueOnce(new Error('send failed'))
  .mockRejectedValueOnce(turnInProgressError)
  .mockResolvedValueOnce(undefined);
```

Advance the first one-second retry to reach the terminal failure, explicitly dispatch the retried draft, then advance one second and assert the fourth send occurred. The existing code waits two seconds because it retains the earlier attempt count.

- [ ] **Step 2: Run the timer regression and verify RED**

Run:

```bash
pnpm vitest run src/backend/services/session/service/chat/chat-message-handlers.service.test.ts
```

Expected: the fourth send is missing after one second.

- [ ] **Step 3: Clear attempts on generic terminal failure**

Immediately before publishing the terminal failure, add:

```ts
this.turnInProgressRetryAttempts.delete(dbSessionId);
```

- [ ] **Step 4: Run the handler tests and verify GREEN**

Run:

```bash
pnpm vitest run src/backend/services/session/service/chat/chat-message-handlers.service.test.ts
```

Expected: all tests pass.

### Task 3: Verify and publish

**Files:**
- Verify all modified source and test files.

**Interfaces:**
- Consumes: repository scripts and GitHub CLI authentication.
- Produces: a focused commit on the PR branch and reviewer assignments only.

- [ ] **Step 1: Run focused regression tests**

```bash
pnpm vitest run src/backend/services/session/service/chat/chat-message-handlers.service.test.ts src/backend/services/session/service/session-domain.service.test.ts src/backend/services/session/service/store/session-replay-builder.test.ts src/client/features/chat/chat-reducer.test.ts
```

- [ ] **Step 2: Run repository verification**

```bash
pnpm test
pnpm typecheck
pnpm check
pnpm build
pnpm check:fix
```

- [ ] **Step 3: Review the final diff and commit**

```bash
git diff --check
git status --short
git diff --stat origin/main...HEAD
git add docs/superpowers/plans/2026-07-28-pr-2056-dispatch-failure-replay.md \
  src/backend/services/session/service/store/session-store.types.ts \
  src/backend/services/session/service/store/session-replay-builder.ts \
  src/backend/services/session/service/session-domain.service.ts \
  src/backend/services/session/service/session-domain.service.test.ts \
  src/backend/services/session/service/chat/chat-message-handlers.service.ts \
  src/backend/services/session/service/chat/chat-message-handlers.service.test.ts
git commit -m "Preserve failed dispatches across reconnects"
```

- [ ] **Step 4: Push and request re-review**

```bash
git push
gh pr edit 2056 --add-reviewer cursor
gh pr edit 2056 --add-reviewer cubic-dev-ai
```

Do not post a review-thread reply or top-level PR comment.
