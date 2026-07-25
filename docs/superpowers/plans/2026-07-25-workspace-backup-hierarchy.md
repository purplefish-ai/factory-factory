# Workspace Backup Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve parent-child workspace relationships across backup export and restore while accepting older version-4 backups.

**Architecture:** Extend the existing shared workspace backup contract with one backward-compatible nullable field. Thread that field through the service's explicit export and import mappings, and protect the complete data flow with a focused round-trip test.

**Tech Stack:** TypeScript, Zod, Prisma, Vitest.

## Global Constraints

- Keep backup `schemaVersion` at `4`.
- Parse a missing legacy `parentWorkspaceId` as `null`.
- Include `parentWorkspaceId` explicitly in every newly exported workspace.
- Preserve both parent IDs and `null` values on restore.
- Do not change workspace notification backup behavior or SQLite foreign-key configuration.

---

### Task 1: Preserve workspace hierarchy in backup data

**Files:**
- Modify: `src/shared/schemas/export-data.schema.ts`
- Modify: `src/shared/schemas/export-data.schema.test.ts`
- Modify: `src/backend/orchestration/data-backup.service.ts`
- Modify: `src/backend/orchestration/data-backup.service.test.ts`

**Interfaces:**
- Consumes: Prisma `Workspace.parentWorkspaceId: string | null`.
- Produces: parsed `ExportData.data.workspaces[*].parentWorkspaceId: string | null`.
- Preserves: version-4 payloads that omit the new field by parsing them as top-level workspaces.

- [ ] **Step 1: Add the schema compatibility RED assertion**

In the existing `defaults legacy workspace mode and auto-iteration config` test, assert:

```typescript
expect(parsed.parentWorkspaceId).toBeNull();
```

- [ ] **Step 2: Add the service round-trip RED test**

Create parent and child `Workspace` fixtures from `mockWorkspace`, set the child to `parentWorkspaceId: parentWorkspace.id`, export both, and assert:

```typescript
expect(exported.data.workspaces[1]?.parentWorkspaceId).toBe(parentWorkspace.id);
```

Import that exact `exported` value and assert the second workspace create receives:

```typescript
expect(mockTx.workspace.create).toHaveBeenNthCalledWith(2, {
  data: expect.objectContaining({
    id: childWorkspace.id,
    parentWorkspaceId: parentWorkspace.id,
  }),
});
```

- [ ] **Step 3: Run focused tests to verify RED**

Run:

```bash
pnpm test src/shared/schemas/export-data.schema.test.ts src/backend/orchestration/data-backup.service.test.ts
```

Expected: FAIL because parsed legacy workspaces do not default `parentWorkspaceId` and exported child workspaces omit it.

- [ ] **Step 4: Extend the shared workspace schema**

Add this field beside the workspace identity and relationship fields:

```typescript
parentWorkspaceId: z.string().nullable().optional().default(null),
```

- [ ] **Step 5: Thread the field through export and import**

Add to `DataBackupService.exportData`:

```typescript
parentWorkspaceId: w.parentWorkspaceId,
```

Add to the `tx.workspace.create` input in `importWorkspaces`:

```typescript
parentWorkspaceId: workspace.parentWorkspaceId,
```

- [ ] **Step 6: Run focused tests to verify GREEN**

Run:

```bash
pnpm test src/shared/schemas/export-data.schema.test.ts src/backend/orchestration/data-backup.service.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the focused bug fix**

```bash
git add src/shared/schemas/export-data.schema.ts src/shared/schemas/export-data.schema.test.ts src/backend/orchestration/data-backup.service.ts src/backend/orchestration/data-backup.service.test.ts
git commit -m "Preserve workspace hierarchy in backups (#2002)"
```

### Task 2: Verify and publish

**Files:**
- Review: all files changed from `origin/main`.

**Interfaces:**
- Produces: a clean pushed branch and a GitHub pull request closing issue #2002.

- [ ] **Step 1: Run the required verification suite**

Run:

```bash
pnpm typecheck && pnpm check:fix && pnpm test && pnpm build
```

Expected: every command exits with status 0.

- [ ] **Step 2: Review formatting and the complete diff**

Run `git status --short`, inspect any `pnpm check:fix` edits, then run `git diff origin/main`. Remove debug code, unrelated formatting, unsafe casts, and unnecessary complexity.

- [ ] **Step 3: Commit verification changes if needed**

Stage only intentional in-scope changes and use an imperative commit message under 72 characters. Verify `git status --short` is empty.

- [ ] **Step 4: Push and create the pull request**

Push with `git push -u origin HEAD`. Write `/tmp/pr-body.md` containing a summary, changes, exact verification results, `Closes #2002`, a horizontal rule, and the required Factory Factory signature. Create the PR with:

```bash
gh pr create --title "Fix #2002: Preserve workspace hierarchy in backups" --body-file /tmp/pr-body.md
```

- [ ] **Step 5: Verify the pull request**

Run:

```bash
gh pr view --json url,title,state
```

Expected: an open pull request URL for the current branch.
