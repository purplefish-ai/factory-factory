# File Mention Cursor Revalidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent file mention selection from mutating textarea text when the cursor no longer bounds a valid mention token.

**Architecture:** Recompute the active `@` position from the textarea's live value and cursor inside each hook's selection handler. Validate both the `@` boundary and the cursor's token-end boundary before replacement, then use the fresh position for replacement and cursor placement.

**Tech Stack:** TypeScript, React hooks, Vitest, jsdom, React DOM test harnesses

## Global Constraints

- Apply identical behavior to chat workspace mentions and Kanban project mentions.
- Invalid selection closes and resets the palette without textarea mutation or `onChange`.
- Valid selection preserves the existing `@path ` output and cursor placement behavior.
- Do not introduce shared abstractions or unrelated UI changes.

---

### Task 1: Add project mention regression coverage

**Files:**
- Create: `src/components/chat/chat-input/hooks/use-project-file-mentions.test.ts`

**Interfaces:**
- Consumes: `useProjectFileMentions({ projectId, inputRef, onChange })`
- Produces: Regression coverage through `detectFileMention` and `handleFileMentionSelect`

- [ ] **Step 1: Build a jsdom hook harness**

Render a textarea whose ref is passed to `useProjectFileMentions`, mock `trpc.project.listAllFiles.useQuery`, and expose the latest hook result to each test.

- [ ] **Step 2: Write stale-cursor tests**

Assert that moving before `@` or into the middle of `@src` closes the menu, clears the filter, preserves the original value, and does not call `onChange`.

- [ ] **Step 3: Write valid-cursor tests**

Assert unchanged-cursor replacement produces `Hello @src/foo.ts ` and moving to another complete mention uses that mention's live `@` position.

- [ ] **Step 4: Run tests to verify regression failures**

Run: `pnpm exec vitest run src/components/chat/chat-input/hooks/use-project-file-mentions.test.ts`

Expected: stale-cursor tests fail because selection mutates the textarea with a range beginning at stored state.

### Task 2: Add chat mention regression coverage

**Files:**
- Create: `src/components/chat/chat-input/hooks/use-file-mentions.test.ts`

**Interfaces:**
- Consumes: `useFileMentions({ workspaceId, inputRef, onChange })`
- Produces: Matching regression coverage for chat mentions

- [ ] **Step 1: Build the matching jsdom hook harness**

Render a textarea whose ref is passed to `useFileMentions`, mock `trpc.workspace.listAllFiles.useQuery`, and expose the latest hook result.

- [ ] **Step 2: Repeat invalid and valid cursor cases**

Cover cursor-before-mention, cursor-inside-token, unchanged valid cursor, and a different valid mention position.

- [ ] **Step 3: Run tests to verify regression failures**

Run: `pnpm exec vitest run src/components/chat/chat-input/hooks/use-file-mentions.test.ts`

Expected: stale-cursor tests fail for the same mismatched replacement bounds.

### Task 3: Revalidate selection in both hooks

**Files:**
- Modify: `src/components/chat/chat-input/hooks/use-project-file-mentions.ts`
- Modify: `src/components/chat/chat-input/hooks/use-file-mentions.ts`

**Interfaces:**
- Consumes: Existing `findAtPosition(text, cursorPos)` and `isValidAtPosition(text, atPos)` callbacks
- Produces: Selection handlers that mutate only a live, complete mention token

- [ ] **Step 1: Add live validation to the project hook**

Derive `atPos` and the character at the cursor. Close/reset without mutation when no valid `@` exists or a non-whitespace character follows the cursor. Replace and position the cursor using `atPos` when valid.

- [ ] **Step 2: Run the project hook tests green**

Run: `pnpm exec vitest run src/components/chat/chat-input/hooks/use-project-file-mentions.test.ts`

Expected: all tests pass.

- [ ] **Step 3: Apply the same implementation to the chat hook**

Remove obsolete mention-start state in both hooks after selection uses only the fresh position.

- [ ] **Step 4: Run both hook test files green**

Run: `pnpm exec vitest run src/components/chat/chat-input/hooks/use-project-file-mentions.test.ts src/components/chat/chat-input/hooks/use-file-mentions.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit the focused implementation**

Run: `git add docs/superpowers src/components/chat/chat-input/hooks && git commit -m "Fix file mention selection cursor handling (#1896)"`

### Task 4: Verify and publish

**Files:**
- Review: all files changed from `origin/main`
- Create temporarily: `/tmp/pr-body.md`

**Interfaces:**
- Consumes: committed issue branch
- Produces: pushed branch and GitHub pull request closing #1896

- [ ] **Step 1: Run the required verification chain**

Run: `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`

Expected: all commands exit zero. If unrelated baseline failures persist, record them and investigate without folding unrelated fixes into this patch.

- [ ] **Step 2: Review and commit formatter changes if any**

Run: `git diff origin/main`, `git status -sb`, and commit only files belonging to #1896.

- [ ] **Step 3: Push and create the PR**

Push the current branch with tracking, create the required PR body with summary/testing/`Closes #1896` and the Factory Factory signature, then run `gh pr view --web` and capture the PR URL.
