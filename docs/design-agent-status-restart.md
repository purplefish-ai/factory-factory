# Design Doc: Agent Restart Button in Session Tab Bar

**Branch:** `adeeshaek/could-make-possible-users-see-whether`
**Date:** 2026-03-12
**Status:** Approved for implementation

---

## Problem Statement

When an agent gets stuck or crashes, users have no dedicated action to recover it from within the chat window. The only existing mechanism is knowing to "type a message to retry" — which is non-obvious and hidden behind placeholder text. A visible, always-present Restart button removes this friction.

---

## Final Design Decisions

| Question | Decision |
|---|---|
| Placement | Far right of the session tab bar |
| Always visible | Yes — never hidden; disabled when the parent tab bar is disabled (e.g., while a restart is in progress) |
| Restart behavior | Stop the current session silently, then restart the same session (reuses stored `providerSessionId` for context resumption) |
| Force-stop | Silent — no confirmation dialog |
| Initial prompt | Default: `"Continue with the task."` |
| Button | Text label + icon (no status badge needed) |

---

## Codebase Findings

### Session resumption already works out-of-the-box

When `startSession` is called on a session that already has a stored `providerSessionId`, the backend automatically passes it as `resumeProviderSessionId` to the ACP runtime manager (`session.lifecycle.service.ts:458`). This causes Claude to resume from where it left off — conversation history and task context are preserved natively. No new "context transfer" logic is required.

### Current restart path (implicit)

The existing error-state placeholder ("Type a message to retry...") already triggers a restart via the `user_input` WebSocket handler. What's missing is an **explicit, discoverable button** that does this without requiring a user message.

### Stop → Start sequencing

`stopSession` in the lifecycle service:
- Is fully async and awaits ACP process shutdown
- Handles "already stopped" gracefully (catches errors in a `try/finally`, cleanup always runs)
- Is safe to call even when no ACP client exists

`startSession` in the lifecycle service:
- Checks `isStopInProgress` and throws if a stop is still in flight — so we must await stop before starting
- Throws `"Session is already running"` if an ACP client already exists

The safest way to sequence these atomically is a dedicated backend `restartSession` procedure rather than two sequential client-side mutations. This avoids a race condition where the client fires `startSession` before the backend finishes tearing down the ACP process.

### Session tab bar component

`src/components/workspace/main-view-tab-bar.tsx` already accepts callback props (`onSelectSession`, `onCreateSession`, `onCloseSession`). Adding `onRestartSession` follows the same pattern. The `+` new-session button is currently the rightmost element — the Restart button goes after it.

---

## Implementation Plan

### 1. Backend — new `restartSession` tRPC procedure

**`src/backend/domains/session/lifecycle/session.lifecycle.service.ts`**
- Add `restartSession(sessionId, sendSessionMessage)`:
  0. Guard: check `isStopInProgress(sessionId)` — if true, throw immediately (`"Cannot restart: session is currently being stopped"`)
  1. If session is running, try `stopSession(sessionId, { cleanupTransientRatchetSession: false })`, catching any error
  2. Call `startSession(sessionId, sendSessionMessage, { initialPrompt: 'Continue with the task.' })`

**`src/backend/domains/session/lifecycle/session.service.ts`**
- Expose `restartSession(sessionId)` as a public method (delegates to `SessionLifecycleService`)

**`src/backend/trpc/session.trpc.ts`**
- Add `restartSession: protectedProcedure.input(z.object({ id: z.string() })).mutation(...)` calling `sessionService.restartSession(id)`

### 2. Frontend — wire the button

**`src/components/chat/use-chat-websocket.ts`**
- Add `trpc.session.restartSession.useMutation()`
- Expose `restartSession: () => void` that calls the mutation with the current `sessionId`

**`src/components/workspace/main-view-tab-bar.tsx`**
- Add optional prop `onRestartSession?: () => void`
- Render a `<Button variant="ghost" size="sm">` with `<RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Restart</Button>` at the far right of the tab bar (after the `+` button)
- Button is always rendered (never conditionally hidden); accepts `disabled` prop from the tab bar for consistency with other controls

**`src/client/routes/projects/workspaces/workspace-detail-view.tsx`**
- Add `onRestartSession` to `SessionTabsProps` interface and pass it through to wherever `SessionTabBar` is rendered

**`src/components/workspace/workspace-content-view.tsx`** (or wherever `SessionTabBar` is instantiated)
- Pass `onRestartSession` from props down to `SessionTabBar`

**`src/client/routes/projects/workspaces/workspace-detail-container.tsx`**
- Pull `restartSession` from `useChatWebSocket` and thread it into the `sessionTabs` props

---

## Component / Data Flow (After Changes)

```
useChatWebSocket
  └── restartSession()           ← calls trpc.session.restartSession

workspace-detail-container
  └── sessionTabs.onRestartSession = restartSession

WorkspaceDetailView → WorkspaceContentView
  └── MainViewTabBar
        ├── [Session 1] [Session 2] [+]   (existing)
        └── [↺ Restart]                   ← NEW (far right, always visible)
```

---

## Sequence Diagram (Restart Click)

```
User clicks "Restart"
  → trpc.session.restartSession(sessionId)
    → backend: stopSession(sessionId)      (silently stops/kills ACP process)
    → backend: startSession(sessionId, "Continue with the task.")
      → ACP spawned with resumeProviderSessionId = session.providerSessionId
      → Claude resumes from stored conversation context
  → WebSocket session_runtime_updated: phase='starting'
  → WebSocket session_runtime_updated: phase='running'
```

---

## Files Changed

| File | Change |
|---|---|
| `src/backend/domains/session/lifecycle/session.lifecycle.service.ts` | Add `restartSession()` method |
| `src/backend/domains/session/lifecycle/session.service.ts` | Expose `restartSession()` publicly |
| `src/backend/trpc/session.trpc.ts` | Add `restartSession` procedure |
| `src/components/chat/use-chat-websocket.ts` | Add `restartSession` mutation + expose from hook |
| `src/components/workspace/main-view-tab-bar.tsx` | Add `onRestartSession` prop + Restart button UI |
| `src/client/routes/projects/workspaces/workspace-detail-view.tsx` | Add `onRestartSession` to `SessionTabsProps` |
| `src/components/workspace/workspace-content-view.tsx` | Thread `onRestartSession` to `MainViewTabBar` |
| `src/client/routes/projects/workspaces/workspace-detail-container.tsx` | Connect `restartSession` from hook to view props |
