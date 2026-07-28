# ACP Dispatch Failure Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop generic ACP dispatch errors from immediately redispatching the same message and restore the failed message to the composer for manual retry.

**Architecture:** Keep the existing chat dispatch state machine and its special provider-busy backoff. Change only the generic dequeued-message failure branch so it rolls back the temporary transcript entry, installs a stable error runtime, emits a terminal `FAILED` message event, and leaves the queue empty; the already-scheduled prompt-completion callback will therefore become a no-op.

**Tech Stack:** TypeScript, Vitest, ACP session services, WebSocket chat message-state protocol.

## Global Constraints

- Preserve the provider-busy error path containing `A turn is already in progress for this session`.
- Preserve permanent attachment rejection and stop-generation invalidation behavior.
- Normalize structured ACP errors through the existing `toErrorMessage` helper.
- Do not add a new retry counter, queue state, WebSocket message type, or React component.

---

### Task 1: Terminate Generic Dispatch Failures

**Files:**
- Modify: `src/backend/services/session/service/chat/chat-message-handlers.service.test.ts`
- Modify: `src/backend/services/session/service/chat/chat-message-handlers.service.ts`
- Modify: `src/shared/acp-protocol/protocol/websocket.ts`
- Modify: `src/client/features/chat/reducer/types.ts`
- Modify: `src/client/features/chat/reducer/slices/messages/state-machine.ts`
- Modify: `src/client/features/chat/chat-reducer.test.ts`

**Interfaces:**
- Consumes: `sessionDomainService.removeTranscriptMessageById(sessionId, messageId, { emitSnapshot: false })`, `sessionDomainService.markError(sessionId, errorMessage)`, `sessionDomainService.emitDelta(sessionId, event)`, `MessageState.FAILED`, and `toErrorMessage(error)`.
- Produces: generic dequeued-message dispatch failures emit exactly one terminal `FAILED` event
  with recovery content and are not returned to the session queue.

- [x] **Step 1: Replace the generic requeue expectation with a failing internal-error regression**

In `chat-message-handlers.service.test.ts`, replace the existing test named
`reverts runtime to idle when dispatch fails after markRunning` with:

```ts
it('fails a message once when ACP reports an internal error', async () => {
  const client = {
    isCompactingActive: vi.fn().mockReturnValue(false),
    startCompaction: vi.fn(),
    endCompaction: vi.fn(),
    setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
  };
  const internalError = {
    code: -32_603,
    message: 'Internal error',
  };
  mockSessionService.getSessionClient.mockReturnValue(client);
  mockSessionService.sendSessionMessage.mockRejectedValue(internalError);

  await chatMessageHandlerService.tryDispatchNextMessage('s1');

  expect(mockSessionService.sendSessionMessage).toHaveBeenCalledOnce();
  expect(mockSessionDomainService.removeTranscriptMessageById).toHaveBeenCalledWith('s1', 'm1', {
    emitSnapshot: false,
  });
  expect(mockSessionDomainService.markIdle).not.toHaveBeenCalled();
  expect(mockSessionDomainService.requeueFront).not.toHaveBeenCalled();
  expect(mockSessionDomainService.markError).toHaveBeenCalledWith(
    's1',
    'code -32603: Internal error'
  );
  expect(mockSessionDomainService.emitDelta).toHaveBeenCalledWith('s1', {
    type: 'message_state_changed',
    id: 'm1',
    newState: 'FAILED',
    errorMessage: 'code -32603: Internal error',
    userMessage: {
      text: 'hello',
      timestamp: '2026-02-01T00:00:00.000Z',
      attachments: undefined,
      sessionId: 's1',
    },
  });
});
```

This test catches the production bug where the generic branch calls `markIdle` and `requeueFront`,
which leaves work for the zero-delay prompt-completion callback to redispatch.

In the existing test named
`does not call markIdle when process has already stopped during dispatch failure`, preserve the
stopped-runtime assertion and change the queue assertion to:

```ts
expect(mockSessionDomainService.requeueFront).not.toHaveBeenCalled();
expect(mockSessionDomainService.markError).not.toHaveBeenCalled();
expect(mockSessionDomainService.emitDelta).toHaveBeenCalledWith('s1', {
  type: 'message_state_changed',
  id: 'm1',
  newState: 'FAILED',
  errorMessage: 'send failed',
});
```

This keeps process-exit protection while applying the same terminal message behavior after the ACP
process has already stopped.

In `chat-reducer.test.ts`, add a reducer regression that starts with pending recovery content for
`session-A`, applies `ACCEPTED` and `DISPATCHED` so both pending and queued recovery records are
gone, then applies a `FAILED` event carrying `userMessage.sessionId: 'session-A'`. Assert that the
failed message is removed and `lastRejectedMessage` contains the original text, attachments, error,
and source session.

- [x] **Step 2: Run the focused test and verify the intended red state**

Run:

```bash
pnpm vitest run src/backend/services/session/service/chat/chat-message-handlers.service.test.ts -t "fails a message once when ACP reports an internal error"
```

Expected: FAIL because the internal-error test observes `markIdle` and `requeueFront`, while both
tests observe no `FAILED` event.

- [x] **Step 3: Implement the terminal generic-error branch**

In `ChatMessageHandlerService.handleDispatchError`, leave the stop-generation,
`PermanentAttachmentError`, and `isTurnAlreadyInProgressError` branches unchanged. Replace the final
generic block with:

```ts
const errorMessage = this.formatDispatchError(error);
logger.error('[Chat WS] Failed to dispatch message', {
  dbSessionId,
  messageId: msg.id,
  error: errorMessage,
});
sessionDomainService.removeTranscriptMessageById(dbSessionId, msg.id, {
  emitSnapshot: false,
});
if (acpRuntimeManager.isSessionRunning(dbSessionId)) {
  sessionDomainService.markError(dbSessionId, errorMessage);
}
sessionDomainService.emitDelta(dbSessionId, {
  type: 'message_state_changed',
  id: msg.id,
  newState: MessageState.FAILED,
  errorMessage,
  userMessage: {
    text: msg.text,
    timestamp: msg.timestamp,
    attachments: msg.attachments,
    sessionId: dbSessionId,
  },
});
```

Update the method comment so it states that permanent input errors are rejected, provider-busy
errors are requeued with backoff, and all other dispatch errors fail for explicit user retry.

Add `sessionId?: string` to the shared and client `message_state_changed.userMessage` types. Pass
`userMessage` into `handleRejectedOrFailedState`, and use it as the fallback recovery content when
neither `queuedMessages` nor `pendingMessages` contains the failed ID.

- [x] **Step 4: Run the focused red-green tests**

Run:

```bash
pnpm vitest run src/backend/services/session/service/chat/chat-message-handlers.service.test.ts -t "fails a message once when ACP reports an internal error|backs off instead of immediately retrying when ACP reports an active turn"
```

Expected: both tests PASS. The first proves generic errors terminate; the second proves the known
busy-turn race still requeues and retries with backoff.

- [x] **Step 5: Run the complete handler and session-service test files**

Run:

```bash
pnpm vitest run \
  src/backend/services/session/service/chat/chat-message-handlers.service.test.ts \
  src/backend/services/session/service/lifecycle/session.service.test.ts \
  src/client/features/chat/chat-reducer.test.ts
```

Expected: PASS with no failed or unhandled tests.

- [x] **Step 6: Run repository verification**

Run:

```bash
pnpm check:fix
pnpm typecheck
pnpm check
pnpm test
pnpm build
git diff --check
```

Expected: every command exits zero.

- [x] **Step 7: Review the final diff and commit the fix**

Run:

```bash
git diff -- src/backend/services/session/service/chat/chat-message-handlers.service.ts \
  src/backend/services/session/service/chat/chat-message-handlers.service.test.ts
git status --short
git add \
  docs/superpowers/plans/2026-07-28-acp-dispatch-failure-loop.md \
  docs/superpowers/specs/2026-07-28-acp-dispatch-failure-loop-design.md \
  src/backend/services/session/service/chat/chat-message-handlers.service.ts \
  src/backend/services/session/service/chat/chat-message-handlers.service.test.ts \
  src/shared/acp-protocol/protocol/websocket.ts \
  src/client/features/chat/reducer/types.ts \
  src/client/features/chat/reducer/slices/messages/state-machine.ts \
  src/client/features/chat/chat-reducer.test.ts
git commit -m "Stop ACP dispatch error retry loop"
```

Expected: the diff contains only the planned generic-error behavior and its regression test, and
the commit succeeds.
