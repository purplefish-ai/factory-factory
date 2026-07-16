# Phosphor Icons Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every active `lucide-react` usage with native `@phosphor-icons/react` imports using the regular weight.

**Architecture:** Migrate the dependency and icon bindings directly, without a compatibility barrel or global provider. Use a static regression test to prevent Lucide from returning, update dynamic icon types to Phosphor's `Icon`, and replace vendor-class assertions with application-owned selectors.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, Biome, pnpm, `@phosphor-icons/react` 2.1.10.

## Global Constraints

- Use direct named imports from `@phosphor-icons/react`.
- Use Phosphor's native export names; do not alias them to Lucide names.
- Use Phosphor's default `regular` weight unless an existing filled status marker requires `weight="fill"`.
- Preserve existing dimensions, colors, animations, accessibility, labels, and interactions.
- Do not introduce an icon wrapper, compatibility barrel, or global `IconContext`.
- Remove all active `lucide-react`, `LucideIcon`, and `lucide-` references.
- Keep the repository-owned Factory Factory logo unchanged.
- Do not dispatch subagents unless the user explicitly authorizes multi-agent work.

---

### Task 1: Add the migration regression contract

**Files:**
- Create: `src/lib/icon-library.test.ts`

**Interfaces:**
- Consumes: repository root `package.json`, `src/` tree, and `docs/design/ratchet-ux-simplification-plan.md`
- Produces: a Vitest contract that rejects Lucide dependencies/imports/classes and requires Phosphor

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const thisFile = 'src/lib/icon-library.test.ts';
const lucidePackage = ['lucide', 'react'].join('-');
const lucideClassPrefix = ['lucide', ''].join('-');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : [];
  });
}

describe('icon library', () => {
  it('uses Phosphor without active Lucide references', () => {
    const packageJson = JSON.parse(
      readFileSync(join(repositoryRoot, 'package.json'), 'utf8')
    ) as { dependencies?: Record<string, string> };

    expect(packageJson.dependencies?.['@phosphor-icons/react']).toBeDefined();
    expect(packageJson.dependencies?.[lucidePackage]).toBeUndefined();

    const violations = sourceFiles(join(repositoryRoot, 'src'))
      .filter((path) => relative(repositoryRoot, path) !== thisFile)
      .flatMap((path) => {
        const source = readFileSync(path, 'utf8');
        return source.includes(lucidePackage) ||
          source.includes('LucideIcon') ||
          source.includes(lucideClassPrefix)
          ? [relative(repositoryRoot, path)]
          : [];
      });

    expect(violations).toEqual([]);

    const iconGuidance = readFileSync(
      join(repositoryRoot, 'docs/design/ratchet-ux-simplification-plan.md'),
      'utf8'
    );
    expect(iconGuidance).not.toContain(lucidePackage);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm exec vitest run src/lib/icon-library.test.ts
```

Expected: FAIL because `@phosphor-icons/react` is absent and `lucide-react` is still present.

- [ ] **Step 3: Commit the failing contract**

```bash
git add src/lib/icon-library.test.ts
git commit -m "Test Phosphor icon dependency"
```

---

### Task 2: Replace the dependency and production icon imports

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: every `.ts` or `.tsx` file under `src/client/` and `src/components/` returned by:

```bash
rg -l "from ['\"]lucide-react['\"]" src/client src/components --glob '*.ts' --glob '*.tsx'
```

**Interfaces:**
- Consumes: the mapping table below and existing JSX SVG props/classes
- Produces: direct Phosphor imports and native Phosphor component identifiers

- [ ] **Step 1: Install Phosphor and remove Lucide**

Run:

```bash
pnpm remove lucide-react
pnpm add @phosphor-icons/react@^2.1.10
```

Expected: `package.json` and `pnpm-lock.yaml` contain `@phosphor-icons/react` and no `lucide-react` dependency.

- [ ] **Step 2: Apply the exact semantic mapping**

Use unchanged names directly when Phosphor exports the same name. Apply these renamed exports everywhere:

| Lucide export | Phosphor export |
|---|---|
| `Activity` | `PulseIcon` |
| `AlertCircle` | `WarningCircleIcon` |
| `AlertTriangle`, `AlertTriangleIcon` | `WarningIcon` |
| `ArrowDownToLine` | `DownloadSimpleIcon` |
| `ArrowRightLeft` | `ArrowsLeftRightIcon` |
| `Bot` | `RobotIcon` |
| `CalendarIcon` | `CalendarIcon` |
| `CheckCircle2`, `CheckCircle2Icon` | `CheckCircleIcon` |
| `ChevronDown`, `ChevronDownIcon` | `CaretDownIcon` |
| `ChevronLeft`, `ChevronLeftIcon` | `CaretLeftIcon` |
| `ChevronRight`, `ChevronRightIcon` | `CaretRightIcon` |
| `ChevronUp` | `CaretUpIcon` |
| `ChevronsUpDown` | `CaretUpDownIcon` |
| `CircleDashedIcon` | `CircleDashedIcon` |
| `CircleDot` | `DotOutlineIcon` |
| `CircleSlash` | `ProhibitIcon` |
| `ExternalLink` | `ArrowSquareOutIcon` |
| `FileCheck` | `ClipboardTextIcon` |
| `FileDiff` | `GitDiffIcon` |
| `FileJson` | `FileCodeIcon` |
| `FileQuestion` | `FileDashedIcon` |
| `FolderOpenIcon` | `FolderOpenIcon` |
| `Github` | `GithubLogoIcon` |
| `GripVertical` | `DotsSixVerticalIcon` |
| `HelpCircle` | `QuestionIcon` |
| `ImagePlus` | `ImageIcon` |
| `Layers` | `StackIcon` |
| `Link2` | `LinkIcon` |
| `ListTodo` | `ListChecksIcon` |
| `Loader2`, `Loader2Icon` | `SpinnerGapIcon` |
| `LucideIcon` | `Icon` |
| `MapIcon` | `MapTrifoldIcon` |
| `Menu` | `ListIcon` |
| `MessageCircleQuestion` | `ChatCircleDotsIcon` |
| `MessageSquare` | `ChatIcon` |
| `MessageSquareText` | `ChatTextIcon` |
| `Monitor` | `DesktopIcon` |
| `MoreHorizontal` | `DotsThreeIcon` |
| `Network` | `TreeStructureIcon` |
| `OctagonX` | `XCircleIcon` |
| `PanelLeft`, `PanelRight` | `SidebarSimpleIcon` |
| `RefreshCw`, `RefreshCwIcon` | `ArrowsClockwiseIcon` |
| `RotateCcw` | `ArrowCounterClockwiseIcon` |
| `Save` | `FloppyDiskIcon` |
| `Search` | `MagnifyingGlassIcon` |
| `Send` | `PaperPlaneTiltIcon` |
| `Server` | `HardDrivesIcon` |
| `Settings` | `GearIcon` |
| `Settings2` | `GearSixIcon` |
| `ShieldAlert` | `ShieldWarningIcon` |
| `ShieldX` | `ShieldSlashIcon` |
| `Sparkles` | `SparkleIcon` |
| `TerminalIcon` | `TerminalIcon` |
| `Trash2` | `TrashIcon` |
| `Zap` | `LightningIcon` |

For each source file:

1. Replace the module specifier with `@phosphor-icons/react`.
2. Rename both the import and all references to the native Phosphor name.
3. Deduplicate imports where multiple Lucide exports map to one Phosphor export.
4. Use `type Icon` for dynamic icon component types.
5. Preserve all existing `className`, `aria-*`, event, and animation props.

- [ ] **Step 3: Preserve right-facing sidebars**

Add `mirrored` to the `SidebarSimple` instances that replace `PanelRight` in:

- `src/client/routes/projects/workspaces/workspace-detail-header/toggle-right-panel-button.tsx`
- Any other file where the former `PanelRight` specifically represented a right-hand panel

Example:

```tsx
<SidebarSimple mirrored className="h-4 w-4" />
```

- [ ] **Step 4: Format and run typecheck**

Run:

```bash
pnpm check:fix
pnpm typecheck
```

Expected: formatting succeeds; typecheck may still report test mock names until Task 3, but must not report missing production Phosphor exports.

- [ ] **Step 5: Commit the production migration**

```bash
git add package.json pnpm-lock.yaml src/client src/components
git commit -m "Migrate UI icons to Phosphor"
```

---

### Task 3: Update tests and remove vendor-class coupling

**Files:**
- Modify: `src/client/components/kanban/inline-workspace-form.test.tsx`
- Modify: `src/client/components/kanban/issue-card.test.tsx`
- Modify: `src/client/components/kanban/issue-launch-sheet.test.tsx`
- Modify: `src/client/components/kanban/kanban-card.test.tsx`
- Modify: `src/client/components/workspace-item-content.test.tsx`
- Modify: `src/client/components/workspace-status-icon.test.tsx`
- Modify: `src/components/chat/palette-and-tabbar-regressions.test.tsx`
- Modify: `src/components/chat/question-prompt.test.tsx`
- Modify: `src/components/ui/resizable.handle.test.tsx`
- Modify: `src/components/ui/resizable.persistence.test.tsx`
- Modify: `src/components/workspace/terminal-panel.test.tsx`
- Modify: source components needing application-owned selectors

**Interfaces:**
- Consumes: native Phosphor export names from Task 2
- Produces: mocks and assertions independent of icon-library-generated classes

- [ ] **Step 1: Update icon package mocks**

Replace:

```ts
vi.mock('lucide-react', () => ({
  GripVertical: () => createElement('svg'),
}));
```

with the corresponding Phosphor name:

```ts
vi.mock('@phosphor-icons/react', () => ({
  DotsSixVerticalIcon: () => createElement('svg'),
}));
```

Apply the same mapping table from Task 2 to every mocked export in the listed test files.

- [ ] **Step 2: Add stable selectors for semantic icon states**

Update `src/client/components/workspace-status-icon.tsx` so each returned icon has an application-owned marker:

```tsx
<ShieldWarningIcon data-icon="permission-request" ... />
<ClipboardTextIcon data-icon="plan-approval" ... />
<ChatCircleDotsIcon data-icon="user-question" ... />
<WarningIcon data-icon="runtime-error" ... />
```

Update `src/client/components/workspace-status-icon.test.tsx`:

```ts
expect(markup).toContain('data-icon="permission-request"');
expect(markup).not.toContain('data-icon="runtime-error"');
```

and:

```ts
expect(markup).toContain('data-icon="runtime-error"');
```

- [ ] **Step 3: Replace navigation icon class assertions**

Add accessible labels to the session-tab scroll buttons in `src/components/chat/session-tab-bar.tsx` if they do not already have them:

```tsx
aria-label="Scroll session tabs left"
aria-label="Scroll session tabs right"
```

Then update `src/components/chat/palette-and-tabbar-regressions.test.tsx` to query:

```ts
container.querySelector('[aria-label="Scroll session tabs right"]')
```

instead of `.lucide-chevron-right`.

- [ ] **Step 4: Replace question icon class assertion**

Add `data-slot="question-prompt-icon"` to the responsive icon wrapper in `src/components/chat/question-prompt.tsx`.

Update `src/components/chat/question-prompt.test.tsx`:

```ts
const iconWrapper = container.querySelector('[data-slot="question-prompt-icon"]');
expect(iconWrapper?.className).toContain('hidden');
expect(iconWrapper?.className).toContain('sm:block');
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm exec vitest run \
  src/lib/icon-library.test.ts \
  src/client/components/workspace-status-icon.test.tsx \
  src/components/chat/palette-and-tabbar-regressions.test.tsx \
  src/components/chat/question-prompt.test.tsx \
  src/client/components/kanban/inline-workspace-form.test.tsx \
  src/client/components/kanban/issue-card.test.tsx \
  src/client/components/kanban/issue-launch-sheet.test.tsx \
  src/client/components/kanban/kanban-card.test.tsx \
  src/client/components/workspace-item-content.test.tsx \
  src/components/ui/resizable.handle.test.tsx \
  src/components/ui/resizable.persistence.test.tsx \
  src/components/workspace/terminal-panel.test.tsx
```

Expected: all focused tests pass.

- [ ] **Step 6: Commit test migration**

```bash
git add src
git commit -m "Update icon regression tests"
```

---

### Task 4: Update icon guidance and prove Lucide is gone

**Files:**
- Modify: `docs/design/ratchet-ux-simplification-plan.md`
- Modify: any active source/test/story file still reported by the cleanup searches

**Interfaces:**
- Consumes: completed dependency, production, and test migrations
- Produces: repository with no active Lucide references

- [ ] **Step 1: Update explicit icon guidance**

Replace:

```md
- Standardize iconography to hammer (`lucide-react` Hammer).
```

with:

```md
- Standardize iconography to the Phosphor `HammerIcon` component.
```

- [ ] **Step 2: Run cleanup searches**

Run:

```bash
rg -n "lucide-react|LucideIcon|lucide-" \
  src package.json pnpm-lock.yaml docs/design \
  --glob '!docs/superpowers/**'
```

Expected: no matches.

Run:

```bash
rg -n "from ['\"]@phosphor-icons/react['\"]" src | wc -l
```

Expected: every former production/story import now points directly to Phosphor.

- [ ] **Step 3: Run the regression contract and typecheck**

Run:

```bash
pnpm exec vitest run src/lib/icon-library.test.ts
pnpm typecheck
```

Expected: both pass.

- [ ] **Step 4: Commit cleanup**

```bash
git add docs/design/ratchet-ux-simplification-plan.md src package.json pnpm-lock.yaml
git commit -m "Remove remaining Lucide references"
```

---

### Task 5: Full verification

**Files:**
- Modify only files required to fix migration-caused verification failures

**Interfaces:**
- Consumes: complete Phosphor migration
- Produces: verified build and test evidence

- [ ] **Step 1: Run formatting and guardrails**

Run:

```bash
pnpm check:fix
pnpm check
```

Expected: both pass. Existing non-failing informational warnings may remain.

- [ ] **Step 2: Run all tests**

Run:

```bash
pnpm test
```

Expected: all Vitest suites pass.

- [ ] **Step 3: Run typecheck and production build**

Run:

```bash
pnpm typecheck
pnpm build
```

Expected: both pass and Vite bundles `@phosphor-icons/react` imports successfully.

- [ ] **Step 4: Run final searches and inspect the diff**

Run:

```bash
rg -n "lucide-react|LucideIcon|lucide-" \
  src package.json pnpm-lock.yaml docs/design \
  --glob '!docs/superpowers/**'
git status --short
git diff --check
git diff --stat HEAD~3
```

Expected: no Lucide matches, no whitespace errors, and only migration-related changes.

- [ ] **Step 5: Commit any verification fixes**

```bash
git add -A
git commit -m "Verify Phosphor icon migration"
```

Skip this commit when verification produced no additional changes.
