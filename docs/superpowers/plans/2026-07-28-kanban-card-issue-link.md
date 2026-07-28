# Kanban Card Issue Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a clickable GitHub or Linear issue identifier in a linked workspace's Kanban task card.

**Architecture:** Keep the change inside the Kanban feature because the shared workspace payload already contains every required field. Derive one complete `{ label, url }` value, render it through a focused metadata row, and include that value in the existing card metadata visibility calculation.

**Tech Stack:** React, TypeScript, Vitest, jsdom, Tailwind CSS

## Global Constraints

- GitHub issue labels use `#<number>`.
- Linear issue labels use the stored identifier.
- A complete Linear link takes precedence over a complete GitHub link.
- The link opens in a new tab with `noopener,noreferrer`.
- The link click must prevent workspace-card navigation and stop event propagation.
- Incomplete issue data must not render a nonfunctional link.
- No backend, database, schema, or data-fetching changes are in scope.

---

### Task 1: Render Linked Issues on Kanban Cards

**Files:**
- Modify: `src/client/features/kanban/kanban-card.tsx:1-520`
- Modify: `src/client/features/kanban/kanban-card.stories.tsx:1-340`
- Test: `src/client/features/kanban/kanban-card.test.tsx:1-204`

**Interfaces:**
- Consumes: `WorkspaceWithKanban` fields `githubIssueNumber`, `githubIssueUrl`, `linearIssueIdentifier`, and `linearIssueUrl`
- Produces: a card-local `IssueLink` value with `{ label: string; url: string }`, rendered as Kanban metadata

- [x] **Step 1: Write the failing GitHub issue-link test**

Add `DotOutlineIcon` to the icon mock, then add a test that renders a workspace containing:

```ts
githubIssueNumber: 1905,
githubIssueUrl: 'https://github.com/example/repo/issues/1905',
```

Spy on `window.open`, click the rendered `#1905` button with a bubbling and cancelable `MouseEvent`, and assert:

```ts
expect(container.textContent).toContain('#1905');
expect(container.querySelector('[data-testid="card-content"]')).not.toBeNull();
expect(click.defaultPrevented).toBe(true);
expect(openSpy).toHaveBeenCalledWith(
  'https://github.com/example/repo/issues/1905',
  '_blank',
  'noopener,noreferrer'
);
```

- [x] **Step 2: Run the focused test and verify the RED state**

Run:

```bash
pnpm test src/client/features/kanban/kanban-card.test.tsx
```

Expected: the GitHub test fails because `#1905` and its issue-link button are not rendered.

- [x] **Step 3: Write the failing Linear issue-link test**

Add a second test with:

```ts
linearIssueIdentifier: 'ENG-42',
linearIssueUrl: 'https://linear.app/example/issue/ENG-42',
```

Click the `ENG-42` button and assert that it renders as metadata and calls:

```ts
expect(openSpy).toHaveBeenCalledWith(
  'https://linear.app/example/issue/ENG-42',
  '_blank',
  'noopener,noreferrer'
);
```

Add a guard test that supplies `linearIssueIdentifier` without `linearIssueUrl` and verifies neither the identifier nor card metadata is rendered.

- [x] **Step 4: Run the focused test and verify both tests fail for missing behavior**

Run:

```bash
pnpm test src/client/features/kanban/kanban-card.test.tsx
```

Expected: both provider-specific tests fail because Kanban cards do not yet derive or render issue links.

- [x] **Step 5: Implement the minimal issue metadata row**

In `kanban-card.tsx`:

1. Import `DotOutlineIcon`.
2. Add an `IssueLink` type and a `deriveIssueLink(workspace)` helper that returns a complete Linear link first, then a complete GitHub link, or `null`.
3. Add `IssueRow({ issue })`, styled like the existing pull-request row, whose button prevents default navigation, stops propagation, and opens `issue.url`.
4. Derive `issue` in `deriveCardState`, include it in `hasMetadata`, and return it.
5. Destructure `issue` in `KanbanCard` and render `IssueRow` in `CardContent` before the pull-request row.
6. Add `GitHubIssue` and `LinearIssue` Storybook examples using complete provider links.

The derivation should follow this shape:

```ts
type IssueLink = {
  label: string;
  url: string;
};

function deriveIssueLink(workspace: WorkspaceWithKanban): IssueLink | null {
  if (workspace.linearIssueIdentifier && workspace.linearIssueUrl) {
    return {
      label: workspace.linearIssueIdentifier,
      url: workspace.linearIssueUrl,
    };
  }
  if (workspace.githubIssueNumber != null && workspace.githubIssueUrl) {
    return {
      label: `#${workspace.githubIssueNumber}`,
      url: workspace.githubIssueUrl,
    };
  }
  return null;
}
```

- [x] **Step 6: Run the focused test and verify the GREEN state**

Run:

```bash
pnpm test src/client/features/kanban/kanban-card.test.tsx
```

Expected: all `KanbanCard` tests pass with no warnings or errors.

- [x] **Step 7: Run feature verification**

Run:

```bash
pnpm typecheck
pnpm check
pnpm check:fix
```

Expected: all three commands exit successfully.

- [x] **Step 8: Commit the implementation**

Stage only the plan, component, and test:

```bash
git add docs/superpowers/plans/2026-07-28-kanban-card-issue-link.md \
  src/client/features/kanban/kanban-card.tsx \
  src/client/features/kanban/kanban-card.stories.tsx \
  src/client/features/kanban/kanban-card.test.tsx
git commit -m "Show linked issues on Kanban cards"
```
