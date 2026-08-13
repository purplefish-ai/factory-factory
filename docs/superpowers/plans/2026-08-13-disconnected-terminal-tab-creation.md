# Disconnected Terminal Tab Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent disconnected terminal creation attempts from producing an orphaned pending tab that hides existing terminals after reconnection.

**Architecture:** Keep terminal creation and restoration at their existing `TerminalPanel` boundaries. Reject creation in the shared `handleNewTab` callback whenever the terminal WebSocket is disconnected, leaving the existing no-duplicate restoration guard unchanged.

**Tech Stack:** React, TypeScript, Vitest, jsdom, pnpm

## Global Constraints

- A disconnected new-tab request must not add a local tab, record pending correlation state, change the active tab, or call the WebSocket create function.
- Existing server terminals must remain restorable after a disconnected new-tab request.
- Connected creation, request correlation, terminal-list deduplication, and reconnect controls must retain their current behavior.
- The fix must apply to both the imperative `TerminalPanelRef.createNewTerminal` API and the parent-provided `TerminalTabState.onNewTab` callback through their shared handler.

---

### Task 1: Reject Disconnected Terminal Creation

**Files:**
- Modify: `src/client/features/workspace/terminal-panel.test.tsx`
- Modify: `src/client/features/workspace/terminal-panel.tsx:277-293`

**Interfaces:**
- Consumes: `connected: boolean` from `useTerminalWebSocket` and `TerminalPanelRef.createNewTerminal(): void`.
- Produces: `handleNewTab(): void`, which is a no-op while disconnected and otherwise preserves the existing pending-tab/create flow.

- [ ] **Step 1: Write the failing regression test**

Import `TerminalTabState`, capture the latest state through `onStateChange`, invoke terminal creation while disconnected, and then deliver a server list:

```typescript
it('ignores disconnected create requests without blocking terminal restoration', () => {
  mocks.connected = false;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const panelRef = createRef<TerminalPanelRef>();
  const terminalStates: TerminalTabState[] = [];

  flushSync(() => {
    root.render(
      createElement(TerminalPanel, {
        workspaceId: 'workspace-1',
        ref: panelRef,
        onStateChange: (state) => {
          terminalStates.push(state);
        },
      })
    );
  });

  flushSync(() => {
    panelRef.current?.createNewTerminal();
  });

  expect(mocks.create).not.toHaveBeenCalled();
  expect(terminalStates.at(-1)?.tabs).toEqual([]);

  flushSync(() => {
    mocks.options?.onTerminalList?.([
      { id: 'terminal-existing', createdAt: '2026-08-13T00:00:00.000Z' },
    ]);
  });

  expect(terminalStates.at(-1)?.tabs).toEqual([
    { id: 'tab-terminal-existing', label: 'Terminal 1' },
  ]);

  root.unmount();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm test src/client/features/workspace/terminal-panel.test.tsx -t "ignores disconnected create requests"
```

Expected: FAIL because the current callback calls `create`, appends a pending tab, and prevents the terminal list from replacing it.

- [ ] **Step 3: Update reconnect notice setup so it does not rely on the bug**

In `shows a disconnected notice while the transport is reconnecting`, render and create the terminal while `mocks.connected` is true, associate it through `onCreated`, then set `mocks.connected = false` and rerender the same panel before checking the notice. In `offers a manual reconnect once the transport gives up`, remove the unnecessary disconnected `createNewTerminal` call because the empty state already renders the reconnect control.

- [ ] **Step 4: Implement the minimal connected-state guard**

Add the guard before request ID creation and include `connected` in the callback dependencies:

```typescript
const handleNewTab = useCallback(() => {
  if (!connected) {
    return;
  }

  const requestId = createTerminalRequestId();
  const id = `tab-${requestId}`;

  pendingTabIdsByRequestRef.current.set(requestId, id);
  updateTabs((prev) => [
    ...prev,
    {
      id,
      label: `Terminal ${prev.length + 1}`,
      terminalId: null,
      output: '',
    },
  ]);
  setActiveTabId(id);
  create(requestId);
}, [connected, create, setActiveTabId, updateTabs]);
```

- [ ] **Step 5: Run the panel tests and verify GREEN**

Run:

```bash
pnpm test src/client/features/workspace/terminal-panel.test.tsx
```

Expected: all `TerminalPanel` tests pass without warnings.

- [ ] **Step 6: Commit the regression fix**

```bash
git add src/client/features/workspace/terminal-panel.tsx \
  src/client/features/workspace/terminal-panel.test.tsx
git commit -m "Ignore disconnected terminal creation (#2158)"
```

### Task 2: Full Verification and Publication

**Files:**
- Review: all changes relative to `origin/main`
- Create outside repository: `/tmp/pr-body.md`

**Interfaces:**
- Consumes: the committed terminal creation guard, regression tests, design, and plan.
- Produces: a verified GitHub pull request that closes issue `#2158`.

- [ ] **Step 1: Run repository verification**

Run the user-requested chain and the repository's full guardrail check:

```bash
pnpm typecheck && pnpm check:fix && pnpm test && pnpm build
pnpm check
```

Expected: every command exits `0`. Review and stage any intended formatter changes before the final commit.

- [ ] **Step 2: Review the complete change**

```bash
git diff origin/main
git diff --check origin/main
git status -sb
```

Expected: only the two planning artifacts and the intended terminal panel source/test files differ from `origin/main`; no debug output, unrelated refactoring, or uncommitted changes remain. No screenshot is required because the fix adds no visual state.

- [ ] **Step 3: Commit any verification-only formatting changes**

If `pnpm check:fix` changed intended files, stage only those files and commit them with an imperative subject under 72 characters. If it made no changes, verify `git status --short` is empty.

- [ ] **Step 4: Push and create the pull request**

Confirm `gh --version` and `gh auth status`, push the existing issue branch, write `/tmp/pr-body.md` with the required summary, changes, testing checklist, `Closes #2158`, and Factory Factory signature, then run:

```bash
git push -u origin HEAD
gh pr create --title "Fix #2158: Ignore terminal creation while disconnected" --body-file /tmp/pr-body.md
gh pr view --web
```

Expected: GitHub reports the new pull request URL and successfully opens its web view.
