# Child-Workspace Notification Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Share parent-to-child and child-to-parent live notification delivery in one transport-neutral use case and move child-workspace procedures into a dedicated, publicly composed tRPC router.

**Architecture:** A cross-service orchestration use case will reuse the existing persistence helpers, coordinate session queue/UI/dispatch behavior, and accept direction-specific source metadata and UI-event construction. A dedicated child-workspace router will validate transport inputs and relationships, while `mergeRouters` preserves the existing flat `workspace.*` API without `_def.procedures` access.

**Tech Stack:** TypeScript, tRPC 11.10, Zod, Vitest, Prisma accessors, Biome, pnpm

## Global Constraints

- Parent-to-child and child-to-parent live delivery share one implementation.
- Persist before active-session lookup or enqueue; leave the row pending on no active session or enqueue rejection.
- Preserve canonical `workspaceNotificationMessageId` and `buildWorkspaceNotificationMessageText` output.
- Do not mark a notification delivered until the existing provider-send commit path does so.
- Already-queued notifications return `{ delivered: true }` without a duplicate UI event or dispatch.
- Keep existing flat `workspace.*` procedure paths for client and MCP callers.
- Application/orchestration code must not import tRPC.
- Router composition must not read `_def.procedures`.

---

### Task 1: Shared Notification Delivery Use Case

**Files:**
- Create: `src/backend/orchestration/workspace-notification-delivery.orchestrator.test.ts`
- Create: `src/backend/orchestration/workspace-notification-delivery.orchestrator.ts`

**Interfaces:**
- Consumes: `persistChildNotification`, `persistParentNotification`, `agentSessionAccessor`, `sessionDomainService`, `chatMessageHandlerService`, and the canonical shared notification ID/text helpers.
- Produces: `deliverWorkspaceNotification(input): Promise<{ delivered: boolean }>`.
- Input: direction, target workspace ID, source workspace `{ id, name, projectName }`, message text, and `buildUiEvent(context): AgentMessage`.

- [ ] **Step 1: Write the failing delivery tests**

Create table-driven fixtures for `CHILD_TO_PARENT` and `PARENT_TO_CHILD`. For each direction, call the wished-for API:

```ts
await deliverWorkspaceNotification({
  direction,
  targetWorkspaceId,
  sourceWorkspace,
  message,
  buildUiEvent: ({ timestamp }) => ({
    type: direction === 'CHILD_TO_PARENT' ? 'child_workspace_update' : 'parent_workspace_update',
    text: message,
    timestamp,
  }),
});
```

Assert for both directions that persistence occurs before session lookup/enqueue, the latest `RUNNING` or `IDLE` session is chosen, the canonical queue ID/text/default settings are used, the exact UI event is appended and emitted with its order, and dispatch happens last. Add focused tests proving no-session fallback, persistence returning `null`, startup-race queue deduplication, and enqueue rejection produce the existing result and side-effect boundaries.

- [ ] **Step 2: Run the tests and verify RED**

Run: `env -u NODE_ENV pnpm exec vitest run src/backend/orchestration/workspace-notification-delivery.orchestrator.test.ts`

Expected: FAIL because `workspace-notification-delivery.orchestrator.ts` does not exist.

- [ ] **Step 3: Implement the minimal delivery use case**

Define these contracts and sequence:

```ts
export type WorkspaceNotificationDirection = 'CHILD_TO_PARENT' | 'PARENT_TO_CHILD';

export interface WorkspaceNotificationSource {
  id: string;
  name: string;
  projectName: string;
}

interface WorkspaceNotificationUiEventContext {
  sourceWorkspace: WorkspaceNotificationSource;
  message: string;
  timestamp: string;
}

export interface DeliverWorkspaceNotificationInput {
  direction: WorkspaceNotificationDirection;
  targetWorkspaceId: string;
  sourceWorkspace: WorkspaceNotificationSource;
  message: string;
  buildUiEvent: (context: WorkspaceNotificationUiEventContext) => AgentMessage;
}
```

Choose the existing persistence helper from `direction`, return false on `null`, reverse-find the latest active session, deduplicate by canonical ID, enqueue with the existing default settings, log and return false on queue rejection, append/emit the built UI event, then await `tryDispatchNextMessage` and return true. Do not call `workspaceNotificationAccessor.markDelivered`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `env -u NODE_ENV pnpm exec vitest run src/backend/orchestration/workspace-notification-delivery.orchestrator.test.ts src/backend/orchestration/workspace-children.orchestrator.test.ts`

Expected: PASS with zero failed tests.

- [ ] **Step 5: Commit the use case**

Run:

```bash
git add src/backend/orchestration/workspace-notification-delivery.orchestrator.ts src/backend/orchestration/workspace-notification-delivery.orchestrator.test.ts
git commit -m "Share child workspace notification delivery (#1960)"
```

### Task 2: Dedicated Child-Workspace Router

**Files:**
- Create: `src/backend/trpc/workspace/children.router.test.ts`
- Create: `src/backend/trpc/workspace/children.trpc.ts`
- Modify: `src/backend/trpc/workspace.router.test.ts`
- Modify: `src/backend/trpc/workspace.trpc.ts`

**Interfaces:**
- Consumes: `deliverWorkspaceNotification` from Task 1 and existing child creation/archive/accessor functions.
- Produces: `workspaceChildrenRouter`, retaining the existing flat procedure names and response contracts.

- [ ] **Step 1: Write failing child-router delegation tests**

Create a caller for the wished-for `workspaceChildrenRouter`. Mock the workspace accessor and delivery use case, then assert child-to-parent delegates:

```ts
expect(mockDeliverWorkspaceNotification).toHaveBeenCalledWith({
  direction: 'CHILD_TO_PARENT',
  targetWorkspaceId: 'parent-1',
  sourceWorkspace: { id: 'child-1', name: 'Child WS', projectName: 'Child Project' },
  message: 'hello',
  buildUiEvent: expect.any(Function),
});
```

Invoke `buildUiEvent` from the captured input and assert the exact `child_workspace_update` fields. Mirror the assertion for `PARENT_TO_CHILD` and `parent_workspace_update`. Add transport tests for missing child, child without parent, mismatched parent, missing parent metadata fallback, and the existing create/list/get-parent/archive/pending-count procedures.

- [ ] **Step 2: Run the child-router test and verify RED**

Run: `env -u NODE_ENV pnpm exec vitest run src/backend/trpc/workspace/children.router.test.ts`

Expected: FAIL because `workspace/children.trpc.ts` does not exist.

- [ ] **Step 3: Move child procedures into the dedicated router**

Create `workspaceChildrenRouter = router({ ... })` containing `createChild`, `listChildren`, `getParent`, `sendMessageToParent`, `sendMessageToChild`, `archiveChild`, and `getPendingNotificationCount`. Preserve current Zod schemas and tRPC errors. Replace both duplicated delivery blocks with calls to `deliverWorkspaceNotification`; construct direction-specific UI messages in the callback using the validated workspace metadata.

Delete those procedures and their now-unused imports/logger from `workspace.trpc.ts`. Remove the old delivery behavior cases and mocks from `workspace.router.test.ts`; their stronger shared-use-case and transport coverage now live in the two new test files.

- [ ] **Step 4: Run child, main router, and MCP tests and verify GREEN**

Run:

```bash
env -u NODE_ENV pnpm exec vitest run \
  src/backend/orchestration/workspace-notification-delivery.orchestrator.test.ts \
  src/backend/trpc/workspace/children.router.test.ts \
  src/backend/trpc/workspace.router.test.ts \
  src/backend/services/session/service/acp/child-workspace-mcp-server.test.ts
```

Expected: PASS with existing procedure inputs/outputs and MCP paths unchanged.

- [ ] **Step 5: Commit the router extraction**

Run:

```bash
git add src/backend/trpc/workspace/children.trpc.ts src/backend/trpc/workspace/children.router.test.ts src/backend/trpc/workspace.trpc.ts src/backend/trpc/workspace.router.test.ts
git commit -m "Extract child workspace router (#1960)"
```

### Task 3: Supported Flat Router Composition

**Files:**
- Modify: `src/backend/trpc/trpc.ts`
- Modify: `src/backend/trpc/workspace.trpc.ts`
- Create: `src/backend/trpc/workspace/composition.test.ts`

**Interfaces:**
- Produces: exported `mergeRouters = t.mergeRouters` and a flat `workspaceRouter` composed only through that public API.
- Preserves: `workspace.sendMessageToParent`, `workspace.sendMessageToChild`, and every existing files/Git/IDE/init/run-script procedure path.

- [ ] **Step 1: Write a failing flat-composition test**

Assert public router properties, without reading `_def`, for representative core, child, and existing subrouter procedures:

```ts
expect(workspaceRouter.get).toBeTypeOf('function');
expect(workspaceRouter.sendMessageToParent).toBeTypeOf('function');
expect(workspaceRouter.sendMessageToChild).toBeTypeOf('function');
expect(workspaceRouter.readFile).toBeTypeOf('function');
```

Use the exact existing procedure property names discovered in each subrouter.

- [ ] **Step 2: Run composition coverage and verify RED**

Run: `env -u NODE_ENV pnpm exec vitest run src/backend/trpc/workspace/composition.test.ts`

Expected: FAIL until the supported composition export and merged router are present.

- [ ] **Step 3: Replace internal procedure spreading**

In `trpc.ts`, export `const mergeRouters = t.mergeRouters`. Rename the large router literal to `workspaceCoreRouter`, then export:

```ts
export const workspaceRouter = mergeRouters(
  workspaceCoreRouter,
  workspaceChildrenRouter,
  workspaceFilesRouter,
  workspaceGitRouter,
  workspaceIdeRouter,
  workspaceInitRouter,
  workspaceRunScriptRouter
);
```

Delete every `_def.procedures` spread.

- [ ] **Step 4: Run focused composition and router tests**

Run: `env -u NODE_ENV pnpm exec vitest run src/backend/trpc/workspace/composition.test.ts src/backend/trpc/workspace/children.router.test.ts src/backend/trpc/workspace.router.test.ts`

Expected: PASS.

Run: `rg -n "_def\\.procedures" src/backend/trpc`

Expected: no output.

- [ ] **Step 5: Commit supported composition**

Run:

```bash
git add src/backend/trpc/trpc.ts src/backend/trpc/workspace.trpc.ts src/backend/trpc/workspace/composition.test.ts
git commit -m "Compose workspace routers through tRPC (#1960)"
```

### Task 4: Review and Full Verification

**Files:**
- Modify only issue-scoped files if review or formatter findings require changes.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: a review-ready, fully verified branch.

- [ ] **Step 1: Request focused code review**

Dispatch a reviewer with `origin/main` as the base and current `HEAD`, the issue acceptance criteria, and the design spec. Resolve every Critical and Important finding; document technical disagreement with evidence instead of applying an incorrect suggestion.

- [ ] **Step 2: Run the required verification chain**

Run: `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`

Expected: all four commands exit 0. Review every Biome change before staging.

- [ ] **Step 3: Inspect the complete change**

Run: `git diff origin/main`, `git diff --check`, and `git status --short`.

Expected: only the design, plan, delivery use case, dedicated router, supported composition, and focused tests differ; no debug logs, commented code, `_def.procedures`, or unrelated edits remain.

- [ ] **Step 4: Commit review/format fixes if present**

Stage only issue-scoped files and run `git commit -m "Polish child workspace delivery extraction (#1960)"`. Skip this commit if review and formatting produce no diff.

### Task 5: Publish Pull Request

**Files:**
- Create outside repository: `/tmp/pr-body.md`

**Interfaces:**
- Consumes: a clean, verified feature branch with descriptive commits.
- Produces: a pushed branch and open GitHub pull request closing issue #1960.

- [ ] **Step 1: Verify pre-flight state**

Run: `git status --short --branch && git log --oneline origin/main..HEAD`.

Expected: clean working tree and only issue-scoped commits.

- [ ] **Step 2: Push the feature branch**

Run: `git push -u origin HEAD`.

Expected: the current issue branch tracks its remote counterpart.

- [ ] **Step 3: Create the required PR body and PR**

Write `/tmp/pr-body.md` with Summary, Changes, Testing checkboxes, `Closes #1960`, and these final lines:

```markdown
---
🏭 Forged in [Factory Factory](https://factoryfactory.ai)
```

Run: `gh pr create --title "Fix #1960: Extract child workspace messaging" --body-file /tmp/pr-body.md`.

Expected: GitHub prints the new pull request URL.

- [ ] **Step 4: Verify the pull request**

Run: `gh pr view --json url,title,state`.

Expected: the requested title, `OPEN` state, and pull request URL.
