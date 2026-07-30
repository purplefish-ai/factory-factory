# ExitPlanMode Settings Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep plan mode disabled across refresh after an approved `ExitPlanMode` request.

**Architecture:** Persist the capability-clamped disabled setting at the shared
plan-approval action boundary. Keep the reducer pure and preserve the existing
Codex and non-Codex completion behavior.

**Tech Stack:** React hooks, TypeScript, Vitest, jsdom sessionStorage

## Global Constraints

- Do not change permission-response wire messages or provider-specific completion behavior.
- Do not add persistence side effects to reducers.
- Preserve the `answerQuestion` ExitPlanMode path's in-memory update.

---

### Task 1: Add the regression test and persistence fix

**Files:**
- Modify: `src/client/features/chat/use-chat-state.integration.test.tsx`
- Modify: `src/client/features/chat/use-chat-actions.ts`

**Interfaces:**
- Consumes: `UseChatStateReturn.approvePermission(requestId, allow, optionId?)`
- Produces: session-scoped persisted `ChatSettings` with `planModeEnabled: false`

- [ ] **Step 1: Write the failing integration test**

Add a test that renders `useChatState` for `session-A`, dispatches Codex
capabilities with plan mode enabled, calls `updateSettings` to persist
`planModeEnabled: true`, installs a pending `ExitPlanMode` permission request,
approves it, and asserts:

```typescript
expect(harness.chatRef.current?.chatSettings.planModeEnabled).toBe(false);
expect(loadSettings('session-A')?.planModeEnabled).toBe(false);
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
pnpm test src/client/features/chat/use-chat-state.integration.test.tsx
```

Expected: the new test fails because `loadSettings('session-A')` returns
`planModeEnabled: true`.

- [ ] **Step 3: Implement the minimal persistence change**

In `completeCodexPlanApproval`, after dispatching the existing settings update,
construct and persist capability-aware settings:

```typescript
const syncedSettings = clampChatSettingsForCapabilities(
  { ...state.chatSettings, planModeEnabled: false },
  state.chatCapabilities
);
persistSettings(dbSessionIdRef.current, syncedSettings);
```

Include `dbSessionIdRef` in the callback dependencies.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run:

```bash
pnpm test src/client/features/chat/use-chat-state.integration.test.tsx
```

Expected: all tests in the file pass.

- [ ] **Step 5: Commit**

```bash
git add src/client/features/chat/use-chat-actions.ts \
  src/client/features/chat/use-chat-state.integration.test.tsx
git commit -m "Persist plan mode exit approval (#2093)"
```

### Task 2: Verify, review, and publish

**Files:**
- Review: all changes relative to `origin/main`

**Interfaces:**
- Consumes: the completed regression fix
- Produces: a clean branch and pull request closing issue #2093

- [ ] **Step 1: Run required verification**

```bash
pnpm typecheck && pnpm check:fix && pnpm test && pnpm build
```

- [ ] **Step 2: Review the complete diff and status**

```bash
git diff origin/main
git status -sb
```

- [ ] **Step 3: Commit any formatting-only follow-up if needed**

Stage only files changed by the required formatting check and use a terse,
descriptive commit.

- [ ] **Step 4: Push and create the pull request**

Push the current issue branch, create the requested PR body with verification
results and `Closes #2093`, append the Factory Factory signature, create the PR,
and verify its URL.
