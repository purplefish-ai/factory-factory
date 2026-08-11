# Stopped Subagent Session Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore provider-owned subagent history when an old stopped session is opened, and reveal subagents after session startup without requiring a page refresh.

**Architecture:** Add a browse-only purpose to ACP client creation so `loadSession` can restore a stored provider session without making Factory Factory treat it as actively running. The session lifecycle exposes an idempotent `ensureSubagentBrowseSession` boundary, and both tRPC browse procedures await it before checking negotiated capabilities. The client requests subagents whenever a database session is selected instead of gating the request on a live runtime snapshot.

**Tech Stack:** TypeScript, ACP SDK, Express/tRPC, React, TanStack Query, Vitest.

## Global Constraints

- A stopped Factory Factory session must remain stopped while its provider history is browsed.
- Passive restoration must use the stored provider session ID and must never fall back to creating a new provider session.
- Passive restoration must not send a prompt, dispatch queued notifications, mark the session `RUNNING`, or resume child work.
- Active startup must promote and reuse a browse-only client, applying normal startup side effects once.
- Subagent list/read requests must await ACP initialization and capability negotiation.
- Existing unsupported-provider behavior remains `{ supported: false }` for list and `PRECONDITION_FAILED` for read.

---

### Task 1: Model Browse-Only ACP Clients

**Files:**
- Modify: `src/backend/services/session/service/acp/types.ts`
- Modify: `src/backend/services/session/service/acp/acp-runtime-manager.ts`
- Test: `src/backend/services/session/service/acp/acp-runtime-manager.test.ts`

**Interfaces:**
- Produces: `AcpClientOptions.purpose?: 'active' | 'browse'`.
- Produces: `AcpRuntimeManager.getBrowseClient(sessionId): AcpProcessHandle | undefined`.
- Preserves: `getClient` and `isSessionRunning` expose only active clients.
- Preserves: `getSubagentBrowseCapability`, `listSubagents`, and `readSubagentTranscript` can use active or browse-only clients.

- [ ] **Step 1: Write failing runtime-manager tests**

Add tests proving that a handle registered with browse purpose is excluded from `getClient` and `isSessionRunning`, remains usable by the subagent browse methods, and becomes the same active handle when `getOrCreateClient` is requested with active purpose.

The production mutation caught by these tests is treating an idle history adapter as an active agent session or spawning a second adapter during promotion.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm vitest run src/backend/services/session/service/acp/acp-runtime-manager.test.ts
```

Expected: FAIL because client purpose and browse-client lookup do not exist.

- [ ] **Step 3: Implement client-purpose tracking**

Extend `AcpClientOptions` with:

```ts
purpose?: 'active' | 'browse';
```

Track browse-only session IDs beside the runtime manager's `sessions` map. Default missing purpose to active for all existing callers and test fixtures. `getClient` and `isSessionRunning` must return false for browse-only handles; `getBrowseClient` must return any running handle. An active `getOrCreateClient` call must remove the browse-only marker before returning an existing handle. Delete the marker on process exit and stop cleanup.

Use `getBrowseClient` inside capability lookup and browse handle validation so history remains readable while the parent session is stopped.

- [ ] **Step 4: Prevent browse restoration from creating a new provider session**

In `createOrResumeSession`, when `purpose === 'browse'`, require both a stored provider session ID and advertised `loadSession` support. Rethrow a failed `loadSession` instead of falling through to `newSession`. Preserve the current fallback behavior for active startup.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run the Task 1 command and confirm every test passes.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/backend/services/session/service/acp/types.ts src/backend/services/session/service/acp/acp-runtime-manager.ts src/backend/services/session/service/acp/acp-runtime-manager.test.ts
git commit -m "Support browse-only ACP session restoration"
```

### Task 2: Restore the Parent Session at the Browse API Boundary

**Files:**
- Modify: `src/backend/services/session/service/lifecycle/session.lifecycle.service.ts`
- Modify: `src/backend/trpc/session.trpc.ts`
- Test: `src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts`
- Test: `src/backend/trpc/session.router.test.ts`

**Interfaces:**
- Produces: `SessionLifecycleService.ensureSubagentBrowseSession(sessionId: string): Promise<boolean>`.
- Consumes: `AcpClientOptions.purpose: 'browse'` and `AcpRuntimeManager.getBrowseClient` from Task 1.
- Returns: `true` only after a supported browse capability is negotiated; `false` for a session that cannot support historical browsing without starting a new provider session.

- [ ] **Step 1: Write failing lifecycle regressions**

Add tests for these observable behaviors:

```ts
await service.ensureSubagentBrowseSession('stopped-codex-session');
```

must load the stored provider session with browse purpose while leaving the repository status unchanged, leaving the runtime snapshot stopped, and not delivering pending notifications. A subsequent active `getOrCreateSessionClient` must reuse/promote that handle, update status to `RUNNING`, and perform active startup side effects once.

Also cover a provider without a stored provider session ID returning `false` without spawning ACP.

The production mutations caught are reusing the ordinary startup path, falling back to `newSession`, or failing to promote the restored handle.

- [ ] **Step 2: Run lifecycle tests and verify RED**

Run:

```bash
pnpm vitest run src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts
```

Expected: FAIL because `ensureSubagentBrowseSession` does not exist.

- [ ] **Step 3: Implement passive lifecycle restoration**

Add `ensureSubagentBrowseSession` under the existing per-session startup barrier. It must:

1. Return immediately when `getSubagentBrowseCapability` is already available.
2. Await an in-progress ACP creation before deciding capability support.
3. Load the database session and return `false` unless it is a resumable Codex session with a stored provider session ID and usable workspace context.
4. Create the ACP handle with `purpose: 'browse'`.
5. Skip workspace-start mutation, permission preset application, queued-notification delivery, runtime-alive publication, and `SessionStatus.RUNNING` persistence.
6. Return only after capability negotiation completes.

Track browse-only restoration dynamically so an adapter exit before promotion cleans up processor state without recording an unexpected active-session exit. Active creation removes that marker, promotes the manager handle, and follows the existing startup path.

- [ ] **Step 4: Write failing router regressions**

Update the router test context with `ensureSubagentBrowseSession`. Assert that list and read await it before inspecting capability. For a delayed ensure promise, verify the browse adapter is not called until ensure resolves and is then called without a second request or refresh. Preserve unsupported and error mapping coverage.

The production mutation caught is checking capability before provider restoration finishes.

- [ ] **Step 5: Run router tests and verify RED**

Run:

```bash
pnpm vitest run src/backend/trpc/session.router.test.ts
```

Expected: FAIL because the procedures do not call the lifecycle restore boundary.

- [ ] **Step 6: Await restoration in both tRPC procedures**

For `listSubagents` and `readSubagentTranscript`, call:

```ts
await sessionLifecycleService.ensureSubagentBrowseSession(input.sessionId);
```

before checking `getSubagentBrowseCapability`. Continue returning the existing public unsupported/precondition shapes after restoration reports no capability.

- [ ] **Step 7: Run Task 2 tests and verify GREEN**

Run both Task 2 test commands and confirm every test passes.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/backend/services/session/service/lifecycle/session.lifecycle.service.ts src/backend/trpc/session.trpc.ts src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts src/backend/trpc/session.router.test.ts
git commit -m "Restore stopped sessions for subagent browsing"
```

### Task 3: Request Subagents for Every Selected Session

**Files:**
- Modify: `src/client/routes/projects/workspaces/workspace-detail-container.tsx`
- Modify: `src/client/routes/projects/workspaces/workspace-detail-container.utils.ts`
- Modify: `src/client/routes/projects/workspaces/workspace-detail-container.utils.test.ts`
- Modify: `src/client/routes/projects/workspaces/detail.test.tsx`

**Interfaces:**
- Consumes: backend-owned browse readiness from Task 2.
- Produces: `selectedSessionReady === true` whenever a database session is selected, independent of runtime `processState` and WebSocket hydration timing.

- [ ] **Step 1: Write failing client regressions**

Replace the runtime-alive utility expectation with tests proving a selected stopped session enables the provider-subagent section and no selected session disables it. Add the route regression matching the reported sequence: render an old stopped selected session and assert the list query runs without changing runtime state.

The production mutation caught is reintroducing `processState === 'alive'` as a client query gate.

- [ ] **Step 2: Run client tests and verify RED**

Run:

```bash
pnpm vitest run src/client/routes/projects/workspaces/workspace-detail-container.utils.test.ts src/client/routes/projects/workspaces/detail.test.tsx src/client/features/subagents/provider-subagents-section.test.tsx
```

Expected: FAIL because the current readiness predicate rejects stopped sessions.

- [ ] **Step 3: Remove runtime-process gating**

Derive the provider-subagent section's enabled state solely from the selected database session ID. Remove the obsolete `isProviderSubagentSessionReady` helper and its runtime-state inputs if no other consumer remains. Keep the no-selection guard so child-workspace content is unaffected.

- [ ] **Step 4: Run Task 3 tests and verify GREEN**

Run the Task 3 command and confirm every test passes.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/client/routes/projects/workspaces/workspace-detail-container.tsx src/client/routes/projects/workspaces/workspace-detail-container.utils.ts src/client/routes/projects/workspaces/workspace-detail-container.utils.test.ts src/client/routes/projects/workspaces/detail.test.tsx
git commit -m "Load stopped session subagents without refresh"
```

### Task 4: Cross-Layer Verification and PR Update

**Files:**
- Modify only files required by failures directly caused by Tasks 1-3.

**Interfaces:**
- Consumes: all behavior from Tasks 1-3.
- Produces: a verified branch and updated open PR.

- [ ] **Step 1: Run all focused affected suites**

```bash
pnpm vitest run src/backend/services/session/service/acp/acp-runtime-manager.test.ts src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts src/backend/trpc/session.router.test.ts src/client/routes/projects/workspaces/workspace-detail-container.utils.test.ts src/client/routes/projects/workspaces/detail.test.tsx src/client/features/subagents/provider-subagents-section.test.tsx src/client/features/subagents/use-live-subagent-selection.test.tsx src/client/features/subagents/subagent-transcript-view.test.tsx
```

- [ ] **Step 2: Run repository guardrails**

```bash
pnpm typecheck
pnpm check
pnpm check:fix
git diff --check
```

- [ ] **Step 3: Run the full test suite**

```bash
pnpm test
```

- [ ] **Step 4: Self-review the final diff**

Confirm the diff contains no provider-history persistence, no new-session fallback for browse mode, no prompt/queue dispatch during passive restore, no stale runtime-alive client gate, and tests cover both reported user sequences.

- [ ] **Step 5: Commit any verification-only formatting changes**

```bash
git add src/backend/services/session/service/acp/types.ts src/backend/services/session/service/acp/acp-runtime-manager.ts src/backend/services/session/service/acp/acp-runtime-manager.test.ts src/backend/services/session/service/lifecycle/session.lifecycle.service.ts src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts src/backend/trpc/session.trpc.ts src/backend/trpc/session.router.test.ts src/client/routes/projects/workspaces/workspace-detail-container.tsx src/client/routes/projects/workspaces/workspace-detail-container.utils.ts src/client/routes/projects/workspaces/workspace-detail-container.utils.test.ts src/client/routes/projects/workspaces/detail.test.tsx
git commit -m "Format stopped subagent restoration"
```

Skip this commit when `pnpm check:fix` makes no changes.

- [ ] **Step 6: Push the branch and refresh PR review state**

```bash
git push
gh pr view --json url,state,isDraft,mergeable,statusCheckRollup
```
