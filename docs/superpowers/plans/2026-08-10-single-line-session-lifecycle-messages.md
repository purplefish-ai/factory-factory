# Single-Line Session Lifecycle Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render session lifecycle messages on one line with an ellipsized message and a fully visible, right-aligned timestamp.

**Architecture:** Keep the existing dedicated `SessionLifecycleMessageRenderer` and flatten its message and timestamp into siblings in the existing flex row. Tailwind utilities define the layout contract: the message owns flexible space and truncates, while the icon and timestamp remain fixed-width.

**Tech Stack:** React 19, TypeScript, Tailwind CSS utilities, Vitest, jsdom

## Global Constraints

- Change only `SessionLifecycleMessageRenderer` and its focused test.
- Preserve the existing icon, severity styling, lifecycle copy, timestamp format, spacing container, and accessibility attributes.
- Keep the message and timestamp on one line.
- At narrow widths, truncate only the message and keep the timestamp fully visible.

---

### Task 1: Compact the session lifecycle row

**Files:**
- Modify: `src/client/features/chat/agent-activity/message-renderers/session-lifecycle-message-renderer.tsx:23-45`
- Test: `src/client/features/chat/agent-activity/message-renderers/session-lifecycle-message-renderer.test.tsx:59-75`

**Interfaces:**
- Consumes: `AgentMessage.lifecycle.message` and `AgentMessage.lifecycle.timestamp`
- Produces: the existing `SessionLifecycleMessageRenderer(props): React.JSX.Element | null` with a one-line visual layout; no public API changes

- [ ] **Step 1: Write the failing layout test**

Add this test before the decorative-icon test:

```tsx
it('keeps the timestamp visible while the single-line message truncates', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  flushSync(() => {
    root.render(
      createElement(SessionLifecycleMessageRenderer, {
        message: lifecycleMessage(
          'SYSTEM_STOP',
          'Session stopped because the available horizontal space is intentionally very narrow.'
        ),
      })
    );
  });

  const row = container.querySelector('[data-testid="session-lifecycle-message"]');
  const message = row?.querySelector('p');
  const time = row?.querySelector('time');

  expect(row?.classList.contains('items-center')).toBe(true);
  expect(message?.classList.contains('min-w-0')).toBe(true);
  expect(message?.classList.contains('flex-1')).toBe(true);
  expect(message?.classList.contains('truncate')).toBe(true);
  expect(time?.classList.contains('shrink-0')).toBe(true);
  expect(time?.classList.contains('whitespace-nowrap')).toBe(true);
  expect(message?.nextElementSibling).toBe(time);
  root.unmount();
});
```

This catches regressions that restore vertical stacking, permit message wrapping, or allow the timestamp to shrink out of view.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
pnpm test src/client/features/chat/agent-activity/message-renderers/session-lifecycle-message-renderer.test.tsx
```

Expected: FAIL because the current row uses `items-start`, the message is nested in a wrapper without `truncate`, and the timestamp lacks `shrink-0 whitespace-nowrap`.

- [ ] **Step 3: Implement the minimal one-line layout**

Replace the renderer's row contents and relevant layout classes with:

```tsx
<div
  data-testid="session-lifecycle-message"
  data-severity={isError ? 'error' : 'warning'}
  className={cn(
    'my-2 flex items-center gap-2 rounded-md border px-3 py-2 text-sm',
    isError
      ? 'border-destructive/30 bg-destructive/5 text-destructive'
      : 'border-amber-500/30 bg-amber-500/5 text-muted-foreground',
    className
  )}
>
  <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
  <p className="min-w-0 flex-1 truncate">{message.lifecycle.message}</p>
  <time
    className="shrink-0 whitespace-nowrap text-xs opacity-80"
    dateTime={message.lifecycle.timestamp}
  >
    {new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(message.lifecycle.timestamp))}
  </time>
</div>
```

- [ ] **Step 4: Run focused verification to verify GREEN**

Run:

```bash
pnpm test src/client/features/chat/agent-activity/message-renderers/session-lifecycle-message-renderer.test.tsx
pnpm typecheck
pnpm check
git diff --check
```

Expected: all commands exit successfully with zero test, type, lint, ownership, or dependency-boundary failures.

- [ ] **Step 5: Review and commit the implementation**

Inspect the exact diff and commit only the renderer, its test, and this plan:

```bash
git diff -- src/client/features/chat/agent-activity/message-renderers/session-lifecycle-message-renderer.tsx src/client/features/chat/agent-activity/message-renderers/session-lifecycle-message-renderer.test.tsx docs/superpowers/plans/2026-08-10-single-line-session-lifecycle-messages.md
git add src/client/features/chat/agent-activity/message-renderers/session-lifecycle-message-renderer.tsx src/client/features/chat/agent-activity/message-renderers/session-lifecycle-message-renderer.test.tsx docs/superpowers/plans/2026-08-10-single-line-session-lifecycle-messages.md
git commit -m "Compact session lifecycle messages"
```

- [ ] **Step 6: Publish the requested draft PR**

Confirm GitHub CLI availability and authentication, verify the branch scope, push the current branch, and open a draft PR with a body that explains the compact one-line layout and lists the checks from Step 4.
