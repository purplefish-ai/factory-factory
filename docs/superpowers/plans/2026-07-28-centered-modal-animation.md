# Centered Modal Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every standard and confirmation modal fade and scale at the viewport center without directional travel.

**Architecture:** Keep the behavior in the shared Radix-based `DialogContent` and `AlertDialogContent` primitives so every consumer inherits it without API or call-site changes. Preserve the CSS translations that position content at the viewport center, remove only the animation translation utilities, and override content animation under `prefers-reduced-motion`.

**Tech Stack:** React 19, Radix Dialog and Alert Dialog, Tailwind CSS 4 animation utilities, Vitest 4, jsdom, Storybook

## Global Constraints

- Apply the behavior to `DialogContent` and `AlertDialogContent`.
- Preserve the existing 200 ms duration, overlay fade, centered layout, and public component APIs.
- Open with opacity from 0 to 1 and scale from 95% to 100%; reverse those effects on close.
- Do not add per-modal variants or update individual modal consumers.
- Do not change sheets, drawers, menus, popovers, tooltips, or other anchored surfaces.
- Under `prefers-reduced-motion: reduce`, modal content must have no scale or directional animation.

## File Map

- Create `src/components/ui/dialog.test.tsx` to lock the shared regular-modal and confirmation-modal class contract.
- Create `src/components/ui/dialog.stories.tsx` to provide interactive visual QA for both modal types.
- Modify `src/components/ui/dialog.tsx` to remove directional content animation and add reduced-motion behavior.
- Modify `src/components/ui/alert-dialog.tsx` to make the matching confirmation-modal change.

---

### Task 1: Center all shared modal animation

**Files:**
- Create: `src/components/ui/dialog.test.tsx`
- Create: `src/components/ui/dialog.stories.tsx`
- Modify: `src/components/ui/dialog.tsx:30-52`
- Modify: `src/components/ui/alert-dialog.tsx:27-43`

**Interfaces:**
- Consumes: Radix `data-state="open" | "closed"` attributes and the existing Tailwind animation utilities.
- Produces: unchanged `DialogContent` and `AlertDialogContent` React component APIs with a shared centered-motion class contract.

- [ ] **Step 1: Write the failing shared-primitive test**

Create `src/components/ui/dialog.test.tsx`:

```tsx
// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
} from './alert-dialog';
import { Dialog, DialogContent, DialogTitle } from './dialog';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});

describe('centered modal animation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    void act(() => root.unmount());
    document.body.innerHTML = '';
  });

  function render(element: ReactElement): HTMLElement {
    void act(() => root.render(element));
    const content = document.querySelector<HTMLElement>(
      '[role="dialog"], [role="alertdialog"]'
    );
    expect(content).not.toBeNull();
    return content as HTMLElement;
  }

  function expectCenteredMotion(content: HTMLElement): void {
    expect(content.className).not.toMatch(/slide-(?:in|out)-/);
    expect(content.classList.contains('data-[state=open]:fade-in-0')).toBe(true);
    expect(content.classList.contains('data-[state=closed]:fade-out-0')).toBe(true);
    expect(content.classList.contains('data-[state=open]:zoom-in-95')).toBe(true);
    expect(content.classList.contains('data-[state=closed]:zoom-out-95')).toBe(true);
    expect(content.classList.contains('motion-reduce:data-[state=open]:animate-none')).toBe(true);
    expect(content.classList.contains('motion-reduce:data-[state=closed]:animate-none')).toBe(true);
  }

  it('keeps regular dialog animation centered', () => {
    const content = render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Regular modal</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    expectCenteredMotion(content);
  });

  it('keeps alert dialog animation centered', () => {
    const content = render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Confirmation modal</AlertDialogTitle>
        </AlertDialogContent>
      </AlertDialog>
    );

    expectCenteredMotion(content);
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the current classes fail it**

Run:

```bash
pnpm test -- src/components/ui/dialog.test.tsx
```

Expected: both tests fail because `DialogContent` and `AlertDialogContent` still contain `slide-in-*` and `slide-out-*` classes.

- [ ] **Step 3: Remove directional animation and add reduced-motion overrides**

In `src/components/ui/dialog.tsx`, replace the `DialogPrimitive.Content` class string with:

```tsx
'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-3 border bg-background p-4 shadow-sm duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:rounded-lg'
```

In `src/components/ui/alert-dialog.tsx`, replace the `AlertDialogPrimitive.Content` class string with:

```tsx
'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-sm duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:rounded-lg'
```

Do not alter `DialogOverlay`, `AlertDialogOverlay`, or `src/components/ui/sheet.tsx`.

- [ ] **Step 4: Run the focused test and confirm the class contract passes**

Run:

```bash
pnpm test -- src/components/ui/dialog.test.tsx
```

Expected: 2 tests pass.

- [ ] **Step 5: Add the interactive Storybook coverage**

Create `src/components/ui/dialog.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog';
import { Button } from './button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';

const meta = {
  title: 'UI/Dialog',
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function ModalAnimationPreview() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [alertOpen, setAlertOpen] = useState(false);

  return (
    <div className="flex gap-3">
      <Button onClick={() => setDialogOpen(true)}>Open regular modal</Button>
      <Button variant="destructive" onClick={() => setAlertOpen(true)}>
        Open confirmation modal
      </Button>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Regular modal</DialogTitle>
            <DialogDescription>
              This content should fade and scale without traveling across the viewport.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setDialogOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={alertOpen} onOpenChange={setAlertOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmation modal</AlertDialogTitle>
            <AlertDialogDescription>
              Confirmation content should use the same centered motion.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction>Continue</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export const CenteredMotion: Story = {
  render: () => <ModalAnimationPreview />,
};
```

- [ ] **Step 6: Format and run automated verification**

Run:

```bash
pnpm exec biome check --write src/components/ui/dialog.tsx src/components/ui/alert-dialog.tsx src/components/ui/dialog.test.tsx src/components/ui/dialog.stories.tsx
pnpm test -- src/components/ui/dialog.test.tsx
pnpm test
pnpm typecheck
pnpm check
```

Expected: formatting makes no semantic changes, the focused test reports 2 passing tests, and the full test, type-check, and repository-check commands exit with code 0.

- [ ] **Step 7: Perform visual and scope verification**

Run:

```bash
pnpm storybook
```

Open the `UI/Dialog` → `Centered Motion` story and verify:

1. The regular modal stays centered throughout its open and close animation.
2. The confirmation modal uses the same centered fade-and-scale motion.
3. Browser emulation of `prefers-reduced-motion: reduce` removes content animation.

Stop Storybook, then verify the edit scope:

```bash
git diff --exit-code -- src/components/ui/sheet.tsx
git diff --name-only
```

Expected: the first command exits with code 0 and no output. The second command contains only:

```text
src/components/ui/alert-dialog.tsx
src/components/ui/dialog.stories.tsx
src/components/ui/dialog.test.tsx
src/components/ui/dialog.tsx
```

- [ ] **Step 8: Commit the implementation**

```bash
git add src/components/ui/alert-dialog.tsx src/components/ui/dialog.tsx src/components/ui/dialog.test.tsx src/components/ui/dialog.stories.tsx
git commit -m "Center modal animations"
```
