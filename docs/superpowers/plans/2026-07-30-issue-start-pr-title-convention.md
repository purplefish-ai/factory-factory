# Issue-Start PR Title Convention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach agents started from GitHub or Linear issues to follow documented repository PR-title conventions while retaining the existing issue-title fallback.

**Architecture:** Update the trusted Phase 5 workflow text emitted by the existing shared `buildIssueStartPrompt` function. Keep convention discovery as agent guidance rather than adding runtime parsing or enforcement, and protect the behavior with a focused string-contract test.

**Tech Stack:** TypeScript, Vitest, pnpm

## Global Constraints

- Change only the shared issue-start prompt used by GitHub and Linear issue starts.
- Do not change `prompts/workflows/feature.md`.
- Prefer a PR-title convention specified in repository instructions or contributor documentation.
- When no convention is specified, retain `Fix <issue reference>: [concise description]`.
- Pass the selected title to `gh pr create`.

---

### Task 1: Add Convention-Aware PR Title Guidance

**Files:**
- Modify: `src/shared/issue-start-prompt.ts`
- Test: `src/shared/issue-start-prompt.test.ts`

**Interfaces:**
- Consumes: `buildIssueStartPrompt(params: IssueStartPromptParams): string`
- Produces: Updated trusted Phase 5 workflow text; no TypeScript API changes

- [ ] **Step 1: Write the failing prompt-contract test**

Add this test inside the existing `describe('buildIssueStartPrompt', ...)` block:

```typescript
it('uses a documented repository PR title convention with the existing format as fallback', () => {
  const prompt = buildPrompt();

  expect(prompt).toContain(
    'Check repository instructions and contributor documentation for a PR title convention.'
  );
  expect(prompt).toContain('If a convention is specified, follow it.');
  expect(prompt).toContain(
    'Otherwise, use `Fix #1724: [concise description]` as the PR title.'
  );
  expect(prompt).toContain(
    'gh pr create --title "<selected PR title>" --body-file /tmp/pr-body.md'
  );
});
```

- [ ] **Step 2: Run the focused test and verify the new assertion fails**

Run:

```bash
pnpm vitest run src/shared/issue-start-prompt.test.ts
```

Expected: FAIL because the generated prompt does not yet contain the repository-convention guidance or selected-title command.

- [ ] **Step 3: Add the minimal Phase 5 prompt guidance**

Replace the current PR-creation step with:

```typescript
4. **Choose the PR title:**
   - Check repository instructions and contributor documentation for a PR title convention.
   - If a convention is specified, follow it.
   - Otherwise, use \`Fix ${params.closeReference}: [concise description]\` as the PR title.

5. **Create the PR:**
   \`\`\`bash
   gh pr create --title "<selected PR title>" --body-file /tmp/pr-body.md
   \`\`\`

6. **Verify PR created successfully:**
```

Keep the existing `gh pr view --web` code block beneath step 6.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
pnpm vitest run src/shared/issue-start-prompt.test.ts
```

Expected: all tests in `src/shared/issue-start-prompt.test.ts` pass.

- [ ] **Step 5: Run repository verification**

Run:

```bash
pnpm check && pnpm typecheck && pnpm test
```

Expected: all commands exit with status 0.

- [ ] **Step 6: Review and commit the implementation**

Run:

```bash
git diff --check
git diff -- src/shared/issue-start-prompt.ts src/shared/issue-start-prompt.test.ts
git add src/shared/issue-start-prompt.ts src/shared/issue-start-prompt.test.ts
git commit -m "Update issue-start PR title guidance"
```

Expected: the diff contains only the focused prompt and test changes, and the commit succeeds.

### Task 2: Publish the Pull Request

**Files:**
- No repository files modified

**Interfaces:**
- Consumes: the committed design and verified implementation
- Produces: a pushed branch and an open GitHub pull request

- [ ] **Step 1: Confirm branch scope and clean status**

Run:

```bash
git status --short
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
```

Expected: the worktree is clean and the branch contains only the design and implementation commits for this change.

- [ ] **Step 2: Push the branch**

Run:

```bash
git push -u origin HEAD
```

Expected: the current branch is pushed and tracks its remote counterpart.

- [ ] **Step 3: Create the PR with the repository's established body structure**

Use the title:

```text
Use repository PR title conventions for issue starts
```

Create `/tmp/pr-body.md` with:

```markdown
## Summary

- tell issue-started agents to follow documented repository PR-title conventions
- retain the existing issue-reference title format when no convention is specified
- cover the prompt contract with a focused unit test

## Testing

- `pnpm check`
- `pnpm typecheck`
- `pnpm test`

---
🏭 Forged in [Factory Factory](https://factoryfactory.ai)
```

Then run:

```bash
gh pr create --title "Use repository PR title conventions for issue starts" --body-file /tmp/pr-body.md
```

Expected: GitHub returns the new pull request URL.

- [ ] **Step 4: Verify the PR**

Run:

```bash
gh pr view --json number,title,url,state
```

Expected: the PR is open, its title is `Use repository PR title conventions for issue starts`, and its URL is available for handoff.
