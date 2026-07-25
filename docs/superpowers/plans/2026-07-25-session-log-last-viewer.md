# Session Log Last-Viewer Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep session debug logging open until the final chat WebSocket viewer disconnects.

**Architecture:** Keep `ChatConnectionRegistry` as the single source of truth for active viewers.
Remove the closing connection before consulting its session viewer count, then close the
session-scoped logger only when that count reaches zero.

**Tech Stack:** TypeScript, Express WebSocket handlers, Vitest, pnpm

## Global Constraints

- Preserve the active-socket identity guard for same-connection-ID reconnect races.
- Record `connection_closed` before closing the logger for the final viewer.
- Do not add UI, schema, dependency, or public API changes.
- Run `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`.

---

### Task 1: Gate Session Log Closure on the Final Viewer

**Files:**
- Modify: `src/backend/routers/websocket/chat.handler.ts:260`
- Test: `src/backend/routers/websocket/chat.handler.test.ts:244`

**Interfaces:**
- Consumes: `ChatConnectionRegistry.unregister(connectionId: string): void` and
  `ChatConnectionRegistry.countViewers(dbSessionId: string | null): number`
- Produces: a close-handler lifecycle in which the session logger closes only after the registry
  reports zero viewers

- [ ] **Step 1: Write the failing regression test**

Add a test with two WebSockets returned by consecutive upgrades:

```typescript
it('keeps the session log open until the last viewer disconnects', () => {
  const { appContext, sessionFileLogger } = createTestContext(tempRootDir);
  const handler = createChatUpgradeHandler(appContext);
  const ws1 = new MockWebSocket();
  const ws2 = new MockWebSocket();
  const sockets = [ws1, ws2];
  const wss = {
    handleUpgrade: vi.fn(
      (
        _request: IncomingMessage,
        _socket: Duplex,
        _head: Buffer,
        callback: (socket: WebSocket) => void
      ) => callback(sockets.shift() as unknown as WebSocket)
    ),
  } as unknown as WebSocketServer;
  const request = {
    headers: { origin: allowedOrigin },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage;
  const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
  const wsAliveMap = new WeakMap<WebSocket, boolean>();

  handler(
    request,
    socket,
    Buffer.alloc(0),
    new URL('http://localhost/chat?connectionId=conn-1&sessionId=session-1'),
    wss,
    wsAliveMap
  );
  handler(
    request,
    socket,
    Buffer.alloc(0),
    new URL('http://localhost/chat?connectionId=conn-2&sessionId=session-1'),
    wss,
    wsAliveMap
  );
  expect(chatConnectionRegistry.countViewers('session-1')).toBe(2);

  ws1.emit('close');

  expect(chatConnectionRegistry.countViewers('session-1')).toBe(1);
  expect(sessionFileLogger.closeSession).not.toHaveBeenCalled();

  ws2.emit('close');

  expect(chatConnectionRegistry.countViewers('session-1')).toBe(0);
  expect(sessionFileLogger.closeSession).toHaveBeenCalledTimes(1);
  expect(sessionFileLogger.closeSession).toHaveBeenCalledWith('session-1');
});
```

- [ ] **Step 2: Run the focused test and verify the regression fails**

Run:

```bash
pnpm exec vitest run src/backend/routers/websocket/chat.handler.test.ts
```

Expected: FAIL at `expect(sessionFileLogger.closeSession).not.toHaveBeenCalled()` because the first
viewer currently closes the shared session log.

- [ ] **Step 3: Implement the minimal close-handler fix**

Change the active-socket close branch to remove the connection before checking viewers:

```typescript
if (current?.ws === ws) {
  chatConnectionRegistry.unregister(connectionId);
  if (dbSessionId) {
    sessionFileLogger.log(dbSessionId, 'INFO', {
      event: 'connection_closed',
      connectionId,
    });
    if (chatConnectionRegistry.countViewers(dbSessionId) === 0) {
      sessionFileLogger.closeSession(dbSessionId);
    }
  }
  disconnected = true;
  clearSessionIfDisconnectedAndInactive();
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
pnpm exec vitest run src/backend/routers/websocket/chat.handler.test.ts
```

Expected: PASS, including the existing single-viewer cleanup and stale-close race tests.

- [ ] **Step 5: Commit the focused implementation**

```bash
git add src/backend/routers/websocket/chat.handler.ts \
  src/backend/routers/websocket/chat.handler.test.ts
git commit -m "Fix session log closure for multiple viewers (#1999)"
```

### Task 2: Verify and Publish the Fix

**Files:**
- Verify: `src/backend/routers/websocket/chat.handler.ts`
- Verify: `src/backend/routers/websocket/chat.handler.test.ts`

**Interfaces:**
- Consumes: the completed handler and regression test from Task 1
- Produces: a verified branch and pull request that closes GitHub issue #1999

- [ ] **Step 1: Run the repository verification suite**

```bash
pnpm typecheck && pnpm check:fix && pnpm test && pnpm build
```

Expected: all four commands exit successfully.

- [ ] **Step 2: Review the complete branch diff**

```bash
git diff origin/main
git status -sb
```

Expected: only the design, plan, handler, and handler test changes are present before their
respective commits; no debug code or unrelated edits remain.

- [ ] **Step 3: Push the issue branch**

```bash
git push -u origin HEAD
```

Expected: the current branch is published with upstream tracking.

- [ ] **Step 4: Create and verify the pull request**

Create `/tmp/pr-body.md` with the issue summary, changes, completed checks, `Closes #1999`, and the
required Factory Factory signature, then run:

```bash
gh pr create --title "Fix #1999: Close session logs after last viewer" \
  --body-file /tmp/pr-body.md
gh pr view --json url
```

Expected: GitHub returns the created pull request URL.
