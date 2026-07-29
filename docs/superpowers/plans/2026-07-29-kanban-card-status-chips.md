# Kanban Card Status Chips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Kanban card one canonical status chip and place its issue and pull request links on one compact metadata row.

**Architecture:** Keep workspace-state precedence in the existing shared `statusReason`; add a Kanban-local chip component that only adapts its label and tone for card presentation. Simplify `KanbanCard` to render that chip once, remove the parallel setup/CI presentation paths, and compose issue and PR controls in a single row without changing navigation behavior.

**Tech Stack:** React, TypeScript, Tailwind CSS, Vitest/jsdom, Storybook.

## Global Constraints

- This is a presentation-only change to the Kanban card.
- Do not change shared workspace status-reason derivation, Kanban column projection, snapshot payloads, or labels on other workspace surfaces.
- Render exactly one workspace status chip from `workspace.statusReason`.
- Map `WAITING_FOR_CI` to “CI Running” only on Kanban cards.
- Keep issue and PR controls independently clickable with their current external-navigation and propagation behavior.
- Keep the branch on a separate truncating row below issue/PR metadata.
- Preserve the session runtime error detail beneath the canonical “Session error” chip.
- Do not introduce a new cross-feature API or backend field.

---

### Task 1: Canonical Kanban Status Chip

**Files:**
- Create: `src/client/features/kanban/kanban-card-status-chip.tsx`
- Create: `src/client/features/kanban/kanban-card-status-chip.test.tsx`
- Modify: `src/client/features/kanban/kanban-card.tsx:15-33,330-371,412-424,517-544`
- Modify: `src/client/features/kanban/kanban-card.test.tsx:27-37,67-85,124-211,303-319`

**Interfaces:**
- Consumes: `WorkspaceStatusReason` and `WorkspaceStatusReasonTone` from `@/shared/workspace-status-reason`.
- Produces: `KanbanStatusChip({ statusReason }: { statusReason: WorkspaceStatusReason }): JSX.Element`.
- Produces: one element with `data-testid="kanban-status-chip"` per `KanbanCard` when `workspace.statusReason` is present.

- [ ] **Step 1: Add focused failing tests for the card-local status label and tone mapping**

Create `src/client/features/kanban/kanban-card-status-chip.test.tsx`:

```tsx
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  WorkspaceStatusReason,
  WorkspaceStatusReasonTone,
} from '@/shared/workspace-status-reason';
import { KanbanStatusChip } from './kanban-card-status-chip';

function renderChip(statusReason: WorkspaceStatusReason): string {
  return renderToStaticMarkup(createElement(KanbanStatusChip, { statusReason }));
}

describe('KanbanStatusChip', () => {
  it('renames the waiting-for-CI reason to CI Running', () => {
    const markup = renderChip({
      code: 'WAITING_FOR_CI',
      label: 'Waiting for CI',
      tone: 'waiting',
      needsUser: false,
    });

    expect(markup).toContain('CI Running');
    expect(markup).not.toContain('Waiting for CI');
  });

  it.each([
    ['neutral', 'bg-muted'],
    ['working', 'bg-brand/15'],
    ['waiting', 'bg-yellow-500/15'],
    ['attention', 'bg-amber-500/15'],
    ['success', 'bg-emerald-500/15'],
    ['danger', 'bg-red-500/15'],
  ] satisfies Array<[WorkspaceStatusReasonTone, string]>)(
    'maps the %s tone to its card chip treatment',
    (tone, expectedClass) => {
      const markup = renderChip({
        code: 'READY_FOR_NEXT_PROMPT',
        label: 'Ready',
        tone,
        needsUser: false,
      });

      expect(markup).toContain(expectedClass);
    }
  );
});
```

- [ ] **Step 2: Run the chip test and verify the missing component is the failure**

Run:

```bash
pnpm test src/client/features/kanban/kanban-card-status-chip.test.tsx
```

Expected: FAIL because `./kanban-card-status-chip` does not exist.

- [ ] **Step 3: Implement the minimal Kanban-local chip**

Create `src/client/features/kanban/kanban-card-status-chip.tsx`:

```tsx
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type {
  WorkspaceStatusReason,
  WorkspaceStatusReasonTone,
} from '@/shared/workspace-status-reason';

const TONE_CLASSES: Record<WorkspaceStatusReasonTone, string> = {
  neutral: 'border-transparent bg-muted text-muted-foreground',
  working: 'border-transparent bg-brand/15 text-brand',
  waiting: 'border-transparent bg-yellow-500/15 text-yellow-700 dark:text-yellow-300',
  attention: 'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300',
  success: 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  danger: 'border-transparent bg-red-500/15 text-red-700 dark:text-red-300',
};

function getKanbanStatusLabel(statusReason: WorkspaceStatusReason): string {
  return statusReason.code === 'WAITING_FOR_CI' ? 'CI Running' : statusReason.label;
}

export function KanbanStatusChip({
  statusReason,
}: {
  statusReason: WorkspaceStatusReason;
}) {
  return (
    <Badge
      variant="outline"
      data-testid="kanban-status-chip"
      className={cn(
        'w-fit px-1.5 py-0.5 text-[10px] font-medium tracking-wide',
        TONE_CLASSES[statusReason.tone]
      )}
    >
      {getKanbanStatusLabel(statusReason)}
    </Badge>
  );
}
```

- [ ] **Step 4: Run the focused chip test and verify it passes**

Run:

```bash
pnpm test src/client/features/kanban/kanban-card-status-chip.test.tsx
```

Expected: PASS with 7 cases.

- [ ] **Step 5: Replace the old card-status expectations with failing canonical-chip expectations**

In `src/client/features/kanban/kanban-card.test.tsx`:

1. Delete mocks for `@/client/components/ci-status-chip` and
   `@/client/components/setup-status-chip`.
2. Add the following reason to `baseWorkspace` so every valid test card has the
   same canonical status invariant as production:

```tsx
statusReason: {
  code: 'READY_FOR_NEXT_PROMPT',
  label: 'Ready for next prompt',
  tone: 'neutral',
  needsUser: true,
},
```

3. Replace the first four status tests with:

```tsx
it('renders one canonical status chip for an idle workspace', () => {
  const { container, root } = renderCard(baseWorkspace);
  const chips = container.querySelectorAll('[data-testid="kanban-status-chip"]');

  expect(chips).toHaveLength(1);
  expect(chips[0]?.textContent).toBe('Ready for next prompt');

  root.unmount();
  container.remove();
});

it('uses the canonical status chip for setup', () => {
  const { container, root } = renderCard({
    ...baseWorkspace,
    status: 'PROVISIONING',
    statusReason: {
      code: 'SETTING_UP',
      label: 'Setting up workspace',
      tone: 'working',
      needsUser: false,
    },
  });
  const chips = container.querySelectorAll('[data-testid="kanban-status-chip"]');

  expect(chips).toHaveLength(1);
  expect(chips[0]?.textContent).toBe('Setting up workspace');

  root.unmount();
  container.remove();
});

it('renders CI Running once instead of separate status-reason and CI rows', () => {
  const { container, root } = renderCard({
    ...baseWorkspace,
    prUrl: 'https://github.com/example/repo/pull/42',
    prNumber: 42,
    prState: 'OPEN',
    prCiStatus: 'PENDING',
    statusReason: {
      code: 'WAITING_FOR_CI',
      label: 'Waiting for CI',
      tone: 'waiting',
      needsUser: false,
    },
  });
  const chips = container.querySelectorAll('[data-testid="kanban-status-chip"]');

  expect(chips).toHaveLength(1);
  expect(chips[0]?.textContent).toBe('CI Running');
  expect(container.textContent).not.toContain('Waiting for CI');
  expect(container.textContent).not.toMatch(/\bCI\b(?! Running)/);

  root.unmount();
  container.remove();
});

it('renders the canonical session-error chip with its detailed message', () => {
  const { container, root } = renderCard({
    ...baseWorkspace,
    statusReason: {
      code: 'SESSION_ERROR',
      label: 'Session error',
      tone: 'danger',
      needsUser: true,
    },
    sessionSummaries: [
      {
        sessionId: 'session-1',
        name: null,
        workflow: null,
        model: null,
        persistedStatus: 'FAILED',
        runtimePhase: 'error',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: '2026-05-29T00:00:00.000Z',
        lastExit: null,
        errorMessage: 'Session crashed',
      },
    ],
  });
  const chips = container.querySelectorAll('[data-testid="kanban-status-chip"]');

  expect(chips).toHaveLength(1);
  expect(chips[0]?.textContent).toBe('Session error');
  expect(container.textContent).toContain('Session crashed');

  root.unmount();
  container.remove();
});

it('renders an agent-working reason as the canonical chip', () => {
  const { container, root } = renderCard({
    ...baseWorkspace,
    isWorking: true,
    statusReason: {
      code: 'AGENT_WORKING',
      label: 'Agent working',
      tone: 'working',
      needsUser: false,
    },
  });
  const chips = container.querySelectorAll('[data-testid="kanban-status-chip"]');

  expect(chips).toHaveLength(1);
  expect(chips[0]?.textContent).toBe('Agent working');

  root.unmount();
  container.remove();
});

it('renders an actionable reason as the canonical chip', () => {
  const { container, root } = renderCard({
    ...baseWorkspace,
    statusReason: {
      code: 'NEEDS_PERMISSION',
      label: 'Needs permission',
      tone: 'attention',
      needsUser: true,
    },
  });
  const chips = container.querySelectorAll('[data-testid="kanban-status-chip"]');

  expect(chips).toHaveLength(1);
  expect(chips[0]?.textContent).toBe('Needs permission');

  root.unmount();
  container.remove();
});
```

Update the last incomplete-Linear-link test to expect card content to remain
present because the canonical status chip is always metadata:

```tsx
expect(container.querySelector('[data-testid="card-content"]')).not.toBeNull();
```

- [ ] **Step 6: Run the Kanban card test and verify the old rendering fails the new contract**

Run:

```bash
pnpm test src/client/features/kanban/kanban-card.test.tsx
```

Expected: FAIL because `KanbanCard` does not render
`[data-testid="kanban-status-chip"]` and still emits the setup/CI presentation
paths.

- [ ] **Step 7: Integrate the canonical chip and remove the parallel status paths**

In `src/client/features/kanban/kanban-card.tsx`:

1. Import `KanbanStatusChip` from `./kanban-card-status-chip`.
2. Remove `CiStatusChip`, `SetupStatusChip`,
   `shouldShowWorkspaceStatusReason`, `WorkspaceSidebarCiState`, `PRState`, and
   `deriveWorkspaceSidebarStatus` imports.
3. Delete `CiRow`.
4. In `deriveCardState`, delete `sidebarStatus`, `showSetup`, `showCi`, and
   `showStatusReason`. Make the metadata condition:

```tsx
const hasMetadata =
  Boolean(workspace.statusReason) ||
  showBranch ||
  showPR ||
  !!issue ||
  !!sessionRuntimeError ||
  workspace.mode === 'AUTO_ITERATION' ||
  workspace.creationSource === 'CHILD_WORKSPACE';
```

5. Stop returning and destructuring the deleted state.
6. Make the first `CardContent` child:

```tsx
{workspace.statusReason && <KanbanStatusChip statusReason={workspace.statusReason} />}
```

7. Delete the old setup, plain status-reason, and CI rows.
8. Keep the detailed runtime error row. Do not suppress a `SESSION_ERROR`
   reason merely because the detail exists.

- [ ] **Step 8: Run the chip and card tests together**

Run:

```bash
pnpm test src/client/features/kanban/kanban-card-status-chip.test.tsx src/client/features/kanban/kanban-card.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Format, inspect, and commit the canonical status change**

Run:

```bash
pnpm biome check --write src/client/features/kanban/kanban-card-status-chip.tsx src/client/features/kanban/kanban-card-status-chip.test.tsx src/client/features/kanban/kanban-card.tsx src/client/features/kanban/kanban-card.test.tsx
git diff --check
git diff -- src/client/features/kanban/kanban-card-status-chip.tsx src/client/features/kanban/kanban-card-status-chip.test.tsx src/client/features/kanban/kanban-card.tsx src/client/features/kanban/kanban-card.test.tsx
git add src/client/features/kanban/kanban-card-status-chip.tsx src/client/features/kanban/kanban-card-status-chip.test.tsx src/client/features/kanban/kanban-card.tsx src/client/features/kanban/kanban-card.test.tsx
git commit -m "Normalize Kanban card status chips"
```

Expected: formatting succeeds, the diff contains no whitespace errors, and the
commit contains only canonical-status presentation and tests.

---

### Task 2: Combined Issue and Pull Request Metadata Row

**Files:**
- Modify: `src/client/features/kanban/kanban-card.tsx:67-138,517-545`
- Modify: `src/client/features/kanban/kanban-card.test.tsx:213-319`
- Modify: `src/client/features/kanban/kanban-card.stories.tsx:81-130`

**Interfaces:**
- Consumes: the existing private `IssueLink`, `deriveIssueLink`,
  `workspace.prUrl`, `workspace.prNumber`, `workspace.prState`, and
  `PrStateBadge`.
- Produces: private
  `IssueAndPullRequestRow({ workspace, issue, showPR }): JSX.Element | null`.
- Produces: one wrapper with `data-testid="issue-pr-row"` containing zero to two
  independently clickable external-link buttons.

- [ ] **Step 1: Add a failing integration test for the shared metadata row**

Add this test after the existing GitHub issue test in
`src/client/features/kanban/kanban-card.test.tsx`:

```tsx
it('renders linked issue and pull request controls on one metadata row', () => {
  const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  const onCardClick = vi.fn();
  const { container, root } = renderCard(
    {
      ...baseWorkspace,
      githubIssueNumber: 1905,
      githubIssueUrl: 'https://github.com/example/repo/issues/1905',
      branchName: 'feature/card-style',
      prUrl: 'https://github.com/example/repo/pull/57',
      prNumber: 57,
      prState: 'DRAFT',
    },
    onCardClick
  );
  const row = container.querySelector('[data-testid="issue-pr-row"]');
  const buttons = row?.querySelectorAll('button');

  expect(row?.textContent).toContain('#1905');
  expect(row?.textContent).toContain('#57');
  expect(row?.textContent).toContain('PR');
  expect(buttons).toHaveLength(2);
  expect(row?.nextElementSibling?.textContent).toContain('feature/card-style');

  buttons?.[0]?.click();
  buttons?.[1]?.click();

  expect(openSpy).toHaveBeenNthCalledWith(
    1,
    'https://github.com/example/repo/issues/1905',
    '_blank',
    'noopener,noreferrer'
  );
  expect(openSpy).toHaveBeenNthCalledWith(
    2,
    'https://github.com/example/repo/pull/57',
    '_blank',
    'noopener,noreferrer'
  );
  expect(onCardClick).not.toHaveBeenCalled();

  root.unmount();
  container.remove();
});
```

The current `PrStateBadge` test mock renders “PR”, which verifies that the draft
qualifier remains inside the combined row.

- [ ] **Step 2: Run the test and verify the missing combined row is the failure**

Run:

```bash
pnpm test src/client/features/kanban/kanban-card.test.tsx
```

Expected: FAIL because `[data-testid="issue-pr-row"]` does not exist.

- [ ] **Step 3: Replace the separate issue and PR rows with one combined component**

In `src/client/features/kanban/kanban-card.tsx`, replace `PullRequestRow` and
`IssueRow` with:

```tsx
function IssueAndPullRequestRow({
  workspace,
  issue,
  showPR,
}: {
  workspace: WorkspaceWithKanban;
  issue: IssueLink | null;
  showPR: boolean;
}) {
  if (!issue && !showPR) {
    return null;
  }

  return (
    <div
      data-testid="issue-pr-row"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground min-w-0"
    >
      {issue && (
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            window.open(issue.url, '_blank', 'noopener,noreferrer');
          }}
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <DotOutlineIcon className="h-3 w-3 shrink-0" />
          <span>{issue.label}</span>
        </button>
      )}
      {showPR && (
        <div className="inline-flex items-center gap-1.5">
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              window.open(workspace.prUrl as string, '_blank', 'noopener,noreferrer');
            }}
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            <GitPullRequestIcon className="h-3 w-3 shrink-0" />
            <span>#{workspace.prNumber}</span>
          </button>
          <PrStateBadge prState={workspace.prState} size="sm" />
        </div>
      )}
    </div>
  );
}
```

Keep `IssueLink` and `deriveIssueLink` private in the same file. In
`CardContent`, render:

```tsx
<IssueAndPullRequestRow workspace={workspace} issue={issue} showPR={showPR} />
{showBranch && (
  <div className="flex items-center">
    <BranchRow branchName={workspace.branchName} />
  </div>
)}
```

Remove the old `<IssueRow>` and `<PullRequestRow>` calls. This order keeps the
branch below the shared links.

- [ ] **Step 4: Run the card test and verify link behavior and row composition**

Run:

```bash
pnpm test src/client/features/kanban/kanban-card.test.tsx
```

Expected: PASS, including both independent `window.open` calls and the draft
qualifier inside the row.

- [ ] **Step 5: Add a combined status/issue/PR Storybook state**

Add this story after `LinearIssue` in
`src/client/features/kanban/kanban-card.stories.tsx`:

```tsx
export const IssueAndPRWithCIRunning: Story = {
  args: {
    workspace: {
      ...baseWorkspace,
      name: 'Tighten Kanban card styling',
      githubIssueNumber: 1905,
      githubIssueUrl: 'https://github.com/example/repo/issues/1905',
      prUrl: 'https://github.com/example/repo/pull/57',
      prNumber: 57,
      prState: 'DRAFT',
      prCiStatus: 'PENDING',
      flowPhase: 'CI_WAIT',
      ciObservation: 'CHECKS_PENDING',
      statusReason: {
        code: 'WAITING_FOR_CI',
        label: 'Waiting for CI',
        tone: 'waiting',
        needsUser: false,
      },
    },
    projectSlug: 'my-project',
  },
};
```

- [ ] **Step 6: Format and run focused verification**

Run:

```bash
pnpm biome check --write src/client/features/kanban/kanban-card.tsx src/client/features/kanban/kanban-card.test.tsx src/client/features/kanban/kanban-card.stories.tsx
pnpm test src/client/features/kanban/kanban-card-status-chip.test.tsx src/client/features/kanban/kanban-card.test.tsx
pnpm typecheck
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit the metadata layout and visual example**

Run:

```bash
git add src/client/features/kanban/kanban-card.tsx src/client/features/kanban/kanban-card.test.tsx src/client/features/kanban/kanban-card.stories.tsx
git commit -m "Tighten Kanban card metadata layout"
```

Expected: the commit contains only the combined metadata row, its regression
test, and its Storybook example.

- [ ] **Step 8: Run the full completion gate**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build:storybook
pnpm check
git status --short
```

Expected: tests, type checking, Storybook build, and repository guardrails all
exit 0. `git status --short` is empty.
