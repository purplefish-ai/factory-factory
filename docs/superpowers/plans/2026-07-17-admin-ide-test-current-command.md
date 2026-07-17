# Admin IDE Test Current Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Admin IDE settings Test button enable and execute from the current custom-command input value rather than stale saved settings.

**Architecture:** Preserve the existing local-input and on-blur persistence flow. Use the same local state for the Test button guard, disabled state, and mutation argument, while retaining server-side validation in the existing mutation.

**Tech Stack:** TypeScript, React, tRPC, Vitest, jsdom, pnpm

## Global Constraints

- Keep on-blur persistence behavior unchanged.
- Keep backend command validation and execution unchanged.
- Preserve the current empty-string behavior without adding trimming or new validation.
- Close GitHub issue #1901 through the pull request.

---

### Task 1: Test and fix unsaved custom command testing

**Files:**
- Modify: `src/client/routes/admin-page.tsx`
- Test: `src/client/routes/admin-page.test.tsx`

**Interfaces:**
- Consumes: `AdminDashboardPage`, mocked `trpc.userSettings.get`, and mocked `trpc.userSettings.testCustomCommand.useMutation`
- Produces: A regression test and implementation proving a draft command enables Test and is passed to `testCustomCommand`

- [ ] **Step 1: Expose configurable settings and distinct mutation spies**

Add a `vi.hoisted` mock object containing mutable user settings plus `updateSettingsMutate` and `testCustomCommandMutate` spies. Use those values in the tRPC mock so the IDE section can be rendered as custom and the test mutation can be asserted independently.

```typescript
const mocks = vi.hoisted(() => ({
  updateSettingsMutate: vi.fn(),
  testCustomCommandMutate: vi.fn(),
  userSettings: {
    playSoundOnComplete: true,
    preferredIde: 'cursor' as 'cursor' | 'vscode' | 'custom',
    customIdeCommand: null as string | null,
    defaultSessionProvider: 'CLAUDE',
    defaultClaudeModel: 'sonnet',
    defaultCodexModel: 'default',
    defaultClaudeReasoningEffort: null,
    defaultCodexReasoningEffort: null,
    defaultWorkspacePermissions: 'STRICT',
    ratchetEnabled: false,
    ratchetReplyToPrComments: true,
    ratchetPermissions: 'YOLO',
  },
}));
```

- [ ] **Step 2: Add the draft-command regression test**

Render custom IDE settings with no saved command, update the native input value to `code-insiders {workspace}`, and assert the Test button transitions from disabled to enabled and invokes the test mutation with the draft.

```typescript
it('tests the current custom command before it has been saved', () => {
  mocks.userSettings.preferredIde = 'custom';
  mocks.userSettings.customIdeCommand = null;

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  flushSync(() => {
    root.render(createElement(AdminDashboardPage));
  });

  const input = container.querySelector<HTMLInputElement>('#custom-command');
  const testButton = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === 'Test'
  );
  const setInputValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )?.set;

  expect(input).not.toBeNull();
  expect(testButton).toBeDefined();
  expect(testButton?.disabled).toBe(true);

  flushSync(() => {
    setInputValue?.call(input, 'code-insiders {workspace}');
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });

  expect(testButton?.disabled).toBe(false);

  flushSync(() => {
    testButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  expect(mocks.testCustomCommandMutate).toHaveBeenCalledWith({
    customCommand: 'code-insiders {workspace}',
  });

  root.unmount();
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run: `pnpm exec vitest run src/client/routes/admin-page.test.tsx`

Expected: FAIL because Test remains disabled after typing while `settings.customIdeCommand` is null.

- [ ] **Step 4: Replace persisted-setting reads in Test behavior**

```typescript
const handleTestCommand = () => {
  if (!localCustomCommand) {
    toast.error('Please enter a custom command first');
    return;
  }
  testCommand.mutate({ customCommand: localCustomCommand });
};
```

Update the button condition to:

```tsx
disabled={testCommand.isPending || !localCustomCommand}
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `pnpm exec vitest run src/client/routes/admin-page.test.tsx`

Expected: all admin-page tests pass.

- [ ] **Step 6: Commit the focused fix**

```bash
git add docs/superpowers/plans/2026-07-17-admin-ide-test-current-command.md src/client/routes/admin-page.tsx src/client/routes/admin-page.test.tsx
git commit -m "Fix IDE command test draft handling (#1901)"
```

### Task 2: Verify, review, capture UI evidence, and publish

**Files:**
- Review: all changes relative to `origin/main`
- Create: `.factory-factory/screenshots/admin-ide-current-command-test.png`

**Interfaces:**
- Consumes: the completed UI fix and regression test
- Produces: a verified commit, UI screenshot, pushed branch, and pull request closing #1901

- [ ] **Step 1: Run required verification**

Run: `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`

Expected: every command exits successfully.

- [ ] **Step 2: Review the complete diff**

Run: `git diff origin/main`, `git diff --check`, and `git status --short`.

Expected: only the design, plan, focused source/test changes, and relevant screenshot differ.

- [ ] **Step 3: Capture and commit the UI screenshot**

Read `factory-factory.json`, run its development command on a free port, open the Admin IDE settings screen, enter an unsaved custom command, and capture `.factory-factory/screenshots/admin-ide-current-command-test.png` showing Test enabled.

- [ ] **Step 4: Push and create the pull request**

Run `git push -u origin HEAD`, then create a PR titled `Fix #1901: Test current custom IDE command` with summary, changes, verification checklist, screenshot, `Closes #1901`, and the required Factory Factory signature.

Expected: `gh pr view` returns the created pull request URL.
