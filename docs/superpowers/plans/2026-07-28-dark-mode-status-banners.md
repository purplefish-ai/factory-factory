# Dark Mode Status Banners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make workspace error, warning, and information banners use theme-aware semantic colors in both light and dark mode.

**Architecture:** Put the semantic class mapping in one dependency-free client utility, then consume it from both confirmed light-only workspace banner implementations. Keep banner layout and behavior unchanged, and add a Storybook palette story for direct light/dark visual inspection.

**Tech Stack:** TypeScript, React, Tailwind CSS v4 semantic theme tokens, Vitest, Storybook

## Global Constraints

- Use the existing `destructive`, `warning`, and `info` theme tokens.
- Preserve banner copy, icons, layout, buttons, and behavior.
- Do not change unrelated diff colors, status dots, provider branding, or components that already support dark mode.
- Add or update Storybook coverage for the UI change.

---

### Task 1: Define and test semantic status banner styles

**Files:**
- Create: `src/client/lib/status-banner-styles.test.ts`
- Create: `src/client/lib/status-banner-styles.ts`

**Interfaces:**
- Consumes: `WorkspaceInitBanner['kind']` from `@/shared/workspace-init`
- Produces: `getStatusBannerClassName(kind: WorkspaceInitBanner['kind']): string`

- [ ] **Step 1: Write the failing semantic mapping tests**

Create `src/client/lib/status-banner-styles.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getStatusBannerClassName } from './status-banner-styles';

describe('getStatusBannerClassName', () => {
  it.each([
    ['error', 'border-destructive/30 bg-destructive/10 text-destructive'],
    ['warning', 'border-warning/30 bg-warning/10 text-warning'],
    ['info', 'border-info/30 bg-info/10 text-info'],
  ] as const)('maps %s banners to theme-aware semantic colors', (kind, expected) => {
    expect(getStatusBannerClassName(kind)).toBe(expected);
  });

  it.each(['error', 'warning', 'info'] as const)(
    'does not use a fixed light-theme palette for %s banners',
    (kind) => {
      expect(getStatusBannerClassName(kind)).not.toMatch(
        /\b(?:bg|border|text)-(?:red|yellow|blue)-/
      );
    }
  );
});
```

- [ ] **Step 2: Run the test and verify the red state**

Run:

```bash
pnpm exec vitest run src/client/lib/status-banner-styles.test.ts
```

Expected: FAIL because `./status-banner-styles` does not exist.

- [ ] **Step 3: Implement the minimal semantic mapping**

Create `src/client/lib/status-banner-styles.ts`:

```ts
import type { WorkspaceInitBanner } from '@/shared/workspace-init';

const STATUS_BANNER_CLASS_NAMES: Record<WorkspaceInitBanner['kind'], string> = {
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  info: 'border-info/30 bg-info/10 text-info',
};

export function getStatusBannerClassName(kind: WorkspaceInitBanner['kind']): string {
  return STATUS_BANNER_CLASS_NAMES[kind];
}
```

- [ ] **Step 4: Run the focused test and verify the green state**

Run:

```bash
pnpm exec vitest run src/client/lib/status-banner-styles.test.ts
```

Expected: both tests pass for all three banner kinds.

### Task 2: Migrate the confirmed workspace banners

**Files:**
- Modify: `src/client/routes/projects/workspaces/workspace-detail-chat-content.tsx:17-22,127-151`
- Modify: `src/client/features/workspace/workspace-content-view.tsx:1-10,109-113`
- Create: `src/client/components/status-banner-palette.stories.tsx`

**Interfaces:**
- Consumes: `getStatusBannerClassName(kind)` from `@/client/lib/status-banner-styles`
- Produces: Theme-aware workspace chat initialization banners, empty-workspace warning, and a visual palette story

- [ ] **Step 1: Replace the workspace chat banner’s fixed palette**

Import `getStatusBannerClassName` from `@/client/lib/status-banner-styles`, delete the local `getInitBannerClass`, and change the `InitStatusBanner` class composition to:

```tsx
className={[
  'rounded-md border p-3 text-sm flex items-start gap-3',
  getStatusBannerClassName(banner.kind),
].join(' ')}
```

- [ ] **Step 2: Replace the empty-workspace warning’s fixed palette**

Import `getStatusBannerClassName` from `@/client/lib/status-banner-styles`, then change the notice to:

```tsx
<div
  className={[
    'border px-4 py-3 rounded-md text-sm',
    getStatusBannerClassName('warning'),
  ].join(' ')}
>
  Workspace is initializing... Please wait for the worktree to be created.
</div>
```

- [ ] **Step 3: Add a Storybook light/dark comparison story**

Create `src/client/components/status-banner-palette.stories.tsx`:

```tsx
import { InfoIcon, WarningIcon } from '@phosphor-icons/react';
import type { Meta, StoryObj } from '@storybook/react';
import { getStatusBannerClassName } from '@/client/lib/status-banner-styles';
import type { WorkspaceInitBanner } from '@/shared/workspace-init';

const BANNERS: Pick<WorkspaceInitBanner, 'kind' | 'message'>[] = [
  { kind: 'error', message: 'Agent failed to start.' },
  { kind: 'warning', message: 'Workspace setup completed with warnings.' },
  { kind: 'info', message: 'Workspace setup is still running.' },
];

function StatusBannerPalette() {
  return (
    <div className="w-[32rem] space-y-3 bg-background p-6 text-foreground">
      {BANNERS.map((banner) => {
        const Icon = banner.kind === 'info' ? InfoIcon : WarningIcon;
        return (
          <div
            key={banner.kind}
            className={[
              'flex items-start gap-3 rounded-md border p-3 text-sm',
              getStatusBannerClassName(banner.kind),
            ].join(' ')}
          >
            <Icon className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium capitalize">{banner.kind}</p>
              <p>{banner.message}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const meta = {
  title: 'Components/StatusBannerPalette',
  component: StatusBannerPalette,
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof StatusBannerPalette>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllStates: Story = {};
```

- [ ] **Step 4: Run focused automated checks**

Run:

```bash
pnpm exec vitest run src/client/lib/status-banner-styles.test.ts
pnpm typecheck
```

Expected: the focused tests and TypeScript check exit zero.

- [ ] **Step 5: Commit the implementation**

Run:

```bash
git add src/client/lib/status-banner-styles.ts \
  src/client/lib/status-banner-styles.test.ts \
  src/client/components/status-banner-palette.stories.tsx \
  src/client/routes/projects/workspaces/workspace-detail-chat-content.tsx \
  src/client/features/workspace/workspace-content-view.tsx
git commit -m "Fix dark mode status banner colors"
```

### Task 3: Verify, review, and publish

**Files:**
- Review: all files changed from `origin/main`
- Create temporarily: a PR body file under a `mktemp -d` directory

**Interfaces:**
- Consumes: the committed dark-mode banner fix
- Produces: verified branch and draft GitHub pull request

- [ ] **Step 1: Inspect the Storybook story in both themes**

Start Storybook with `pnpm storybook`, open `Components/StatusBannerPalette`, and use the Storybook theme control to inspect light and dark mode. Confirm each banner has a subtle tinted surface, legible text and border, and unchanged icon/layout alignment.

- [ ] **Step 2: Run the complete verification chain**

Run:

```bash
pnpm check:fix
pnpm test
pnpm typecheck
pnpm check
pnpm build:storybook
```

Expected: every command exits zero. Review formatter changes and keep only files in scope.

- [ ] **Step 3: Request an independent code review**

Provide the reviewer with the diff from `origin/main`, the approved design spec, and the requirement to catch any remaining light-only banner classes, semantic-token mistakes, regressions, or scope creep. Address every critical or important finding before publishing.

- [ ] **Step 4: Confirm publish scope and GitHub prerequisites**

Run:

```bash
git status -sb
git diff --check origin/main
git diff --stat origin/main
gh --version
gh auth status
```

Expected: only the design, plan, semantic style utility/test/story, and two banner consumers differ from `origin/main`; GitHub CLI is installed and authenticated.

- [ ] **Step 5: Push and create the draft pull request**

Push the current branch with tracking. Create a draft PR targeting the repository’s default branch with:

- A concise summary of the semantic banner mapping and migrated callers.
- The root cause: fixed light-palette utility classes bypassed dark-theme tokens.
- User impact: workspace status banners now match both themes.
- The complete verification commands and results.

- [ ] **Step 6: Report the published result**

Return the branch name, commit SHAs, draft PR URL and target, verification results, and any non-blocking review notes.
