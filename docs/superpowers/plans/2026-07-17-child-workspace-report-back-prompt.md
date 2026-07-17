# Child Workspace Report-Back Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver child workspace reporting guidance, including `reportBackOn`, through the queued initial message that ACP agents receive.

**Architecture:** A pure helper in the session capsule owns the canonical child-context text. Workspace initialization resolves the parent context, prepends that text to the initial queued message, and preserves the existing queue, attachment, and non-child behavior.

**Tech Stack:** TypeScript, Express backend service capsules, Prisma accessors, Vitest, pnpm.

## Global Constraints

- Import session behavior only through the `@/backend/services/session` barrel outside the session capsule.
- Deliver instructions through `enqueueAutoMessage`; ACP `newSession` and `loadSession` do not accept a system prompt.
- Preserve the initial message's attachments.
- Queue child context even when `initialPrompt` is absent, empty, or whitespace-only.
- Ignore non-string `reportBackOn` metadata.
- Do not change UI behavior or broaden the fix to other dead `systemPrompt` content.

---

### Task 1: Add the regression tests

**Files:**
- Test: `src/backend/orchestration/workspace-init.orchestrator.test.ts`

**Interfaces:**
- Consumes: `initializeWorkspaceWorktree(workspaceId: string): Promise<void>` and the mocked `workspaceAccessor`, `sessionDomainService`, and `agentSessionAccessor` service APIs.
- Produces: Regression coverage for child context composition and context-only queue delivery.

- [ ] **Step 1: Write a failing child prompt test**

Add a test under `default Claude session auto-start` that creates a child workspace with `parentWorkspaceId`, `initialPrompt`, and `reportBackOn`, mocks `workspaceAccessor.findParentWorkspace` with parent/project names, initializes the workspace, and asserts the queued text contains the child header and report condition before the task text.

```ts
expect(queued.text).toContain('## Child Workspace Context');
expect(queued.text).toContain('Report back when: a PR is opened');
expect(queued.text.indexOf('## Child Workspace Context')).toBeLessThan(
  queued.text.indexOf('Implement the fix')
);
```

- [ ] **Step 2: Write a failing context-only test**

Add a child case with no `initialPrompt` and assert `sessionDomainService.enqueue` still receives a message containing the generic child reporting guidance.

```ts
expect(sessionDomainService.enqueue).toHaveBeenCalledWith(
  'session-1',
  expect.objectContaining({ text: expect.stringContaining('send_message_to_parent') })
);
```

- [ ] **Step 3: Run the focused test and verify RED**

Run: `pnpm vitest run src/backend/orchestration/workspace-init.orchestrator.test.ts`

Expected: the new tests fail because `findParentWorkspace` is not called and the queued message lacks child context.

### Task 2: Deliver child context through the queue

**Files:**
- Modify: `src/backend/services/session/service/lifecycle/session.prompt-builder.ts`
- Modify: `src/backend/services/session/service/index.ts`
- Modify: `src/backend/orchestration/workspace-init.orchestrator.ts`
- Test: `src/backend/orchestration/workspace-init.orchestrator.test.ts`

**Interfaces:**
- Consumes: `workspaceAccessor.findParentWorkspace(childId: string)` and creation metadata fields `reportBackOn` and `initialPrompt`.
- Produces: `buildChildWorkspaceContext(input: { parentWorkspaceName?: string | null; parentProjectName?: string | null; reportBackOn?: string | null }): string` exported by `@/backend/services/session`.

- [ ] **Step 1: Extract the canonical pure helper**

Move the existing child-workspace wording into `buildChildWorkspaceContext`, returning the complete Markdown block. Make `SessionPromptBuilder.buildSystemPrompt` call it when `parentWorkspaceId` is present, then export it from the session service barrel.

```ts
export function buildChildWorkspaceContext(input: {
  parentWorkspaceName?: string | null;
  parentProjectName?: string | null;
  reportBackOn?: string | null;
}): string {
  const parentName = input.parentWorkspaceName ?? 'unknown';
  const projectName = input.parentProjectName ?? 'unknown project';
  let context =
    `## Child Workspace Context\n` +
    `You are working in a child workspace created by the parent workspace "${parentName}" (project: ${projectName}). ` +
    `When you have completed your task or reached a significant milestone — especially if you produced a PR, a finding, or are blocked — ` +
    `use the \`send_message_to_parent\` tool to report back. Include a brief summary of what was done and any next steps the parent workspace should be aware of.`;
  if (input.reportBackOn) {
    context += `\nReport back when: ${input.reportBackOn}`;
  }
  return `${context}\n`;
}
```

- [ ] **Step 2: Compose the queued child message**

In `startDefaultAgentSession`, resolve the parent only for child workspaces, ignore non-string `reportBackOn`, prepend the helper output to the resolved initial text, and carry through existing attachments.

```ts
const initialMessage = await resolveInitialAutoMessageContent(workspaceId, metadata);
const childContext = workspace?.parentWorkspaceId
  ? buildChildWorkspaceContext({
      parentWorkspaceName: parent?.name,
      parentProjectName: parent?.project.name,
      reportBackOn: typeof metadata?.reportBackOn === 'string' ? metadata.reportBackOn : undefined,
    })
  : undefined;
const messageToEnqueue = childContext
  ? { text: `${childContext}\n${initialMessage?.text ?? ''}`.trimEnd(), attachments: initialMessage?.attachments }
  : initialMessage;
```

- [ ] **Step 3: Run the focused test and verify GREEN**

Run: `pnpm vitest run src/backend/orchestration/workspace-init.orchestrator.test.ts src/backend/services/session/service/lifecycle/session.prompt-builder.test.ts`

Expected: both files pass with zero failed tests.

- [ ] **Step 4: Commit the functional change**

```bash
git add src/backend/orchestration/workspace-init.orchestrator.ts src/backend/orchestration/workspace-init.orchestrator.test.ts src/backend/services/session/service/lifecycle/session.prompt-builder.ts src/backend/services/session/service/index.ts
git commit -m "Fix child report-back prompt delivery (#1897)"
```

### Task 3: Verify and publish

**Files:**
- Review: all files changed from `origin/main`
- Create temporarily: `/tmp/pr-body.md`

**Interfaces:**
- Consumes: the completed implementation and repository verification scripts.
- Produces: a pushed branch and GitHub pull request closing issue #1897.

- [ ] **Step 1: Run required verification**

Run: `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`

Expected: typecheck, checks, tests, and build exit successfully. If the known baseline failures remain, record them precisely and do not attribute them to this diff.

- [ ] **Step 2: Review the full branch diff**

Run: `git diff origin/main` and `git status --short --branch`.

Expected: only the scoped design, plan, source, and test files are changed; no debug output is present.

- [ ] **Step 3: Commit verification-only formatting changes if any**

```bash
git add docs/superpowers/specs/2026-07-17-child-workspace-report-back-prompt-design.md docs/superpowers/plans/2026-07-17-child-workspace-report-back-prompt.md src/backend/orchestration/workspace-init.orchestrator.ts src/backend/orchestration/workspace-init.orchestrator.test.ts src/backend/services/session/service/lifecycle/session.prompt-builder.ts src/backend/services/session/service/index.ts
git commit -m "Document child prompt delivery fix (#1897)"
```

Skip this commit when there are no remaining uncommitted changes.

- [ ] **Step 4: Push and create the PR**

Push with `git push -u origin HEAD`, write the required summary, testing checklist, `Closes #1897`, and Factory Factory signature to `/tmp/pr-body.md`, then run:

```bash
gh pr create --title "Fix #1897: Deliver child report-back instructions" --body-file /tmp/pr-body.md
gh pr view --json url,title,state
```

Expected: GitHub reports an open PR URL for the current branch.
