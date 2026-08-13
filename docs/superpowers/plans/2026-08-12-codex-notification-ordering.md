# Codex Notification Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Codex app-server notification order so a late-started handler cannot reopen an already completed ACP tool call.

**Architecture:** Add failure-isolated per-item promise chains at the Codex notification entry point. Keep turn/thread notifications, stream projection logic, ACP timeout behavior, and server-request handling unchanged.

**Tech Stack:** TypeScript, Codex app-server JSON-RPC, ACP SDK, Vitest

## Global Constraints

- Use pnpm only.
- Preserve provider notification order for each thread item.
- A failed notification must not poison processing of later notifications.
- Do not block turn completion while a plan item awaits user approval.
- Do not change tool timeout durations or synthesize provider completion statuses.

---

### Task 1: Serialize Codex notifications

**Files:**
- Create: `src/backend/services/session/service/acp/codex-app-server-adapter/codex-notification-queue.ts`
- Create: `src/backend/services/session/service/acp/codex-app-server-adapter/codex-notification-queue.test.ts`
- Create: `src/backend/services/session/service/acp/codex-app-server-adapter/codex-app-server-acp-adapter.notification-ordering.test.ts`
- Modify: `src/backend/services/session/service/acp/codex-app-server-adapter/codex-app-server-acp-adapter.ts`

**Interfaces:**
- Consumes: Codex notifications as `{ method: string; params: unknown }` in callback order.
- Produces: per-item ordered calls to `CodexStreamEventHandler.handleCodexNotification` and a resolved queue after per-notification failures are reported.

- [x] **Step 1: Write the failing race regression**

Create a deferred first ACP session update, deliver `item/started` and `item/completed` concurrently, release the deferred update, and assert status order is exactly `pending`, `in_progress`, `completed`.

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm test src/backend/services/session/service/acp/codex-app-server-adapter/codex-app-server-acp-adapter.notification-ordering.test.ts -t "preserves Codex notification order"`

Expected: FAIL because `completed` is observed before the late `in_progress` update.

- [x] **Step 3: Implement the notification chain**

Add a `Promise<void>` chain per thread-item key to `CodexAppServerAcpAdapter`. Append matching item notification handlers to it, remove settled chains, and absorb each link's failure after best-effort reporting so later notifications continue. Process notifications without an item key immediately. Cover rejected handlers and throwing reporters in the queue's focused test.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run: `pnpm test src/backend/services/session/service/acp/codex-app-server-adapter/codex-app-server-acp-adapter.test.ts src/backend/services/session/service/acp/codex-app-server-adapter/stream-event-handler.test.ts`

Expected: both files pass.

- [x] **Step 5: Run repository verification**

Run, in order: `pnpm check:fix`, `pnpm typecheck`, `pnpm test`, and `pnpm check`.
