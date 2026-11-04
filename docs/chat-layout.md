# Workspace chat layout

The message viewport takes the remaining height above the composer. When the
user scrolls away from the latest messages, the **Scroll to bottom** control
occupies a nonshrinking row between the viewport and composer. Keeping this row
in normal layout flow makes it visible and clickable as multiline drafts,
attachments, permission prompts, and questions change the composer height. Tall
permission and question prompts scroll within the available composer height,
keeping the input and its controls reachable on narrow screens. Clicking it
returns to the latest messages and hides the row.

For local UI checks, open **Workspace / ChatContent / Composer Height Changes**
in `pnpm storybook`. This story uses mock conversation messages and local
callbacks; it never sends messages or starts a session. Use its controls to add
attachments and show permission or question prompts, then enter a multiline
draft and scroll up and down.

Run the browser regressions with
`pnpm exec playwright test --config=playwright.chat.config.ts`. They start a
frontend-only Storybook server, stub the voice configuration read, and check
button hit-testing, composer growth and shrinkage, draft preservation, and
scrolling at 320px, 375px, and desktop widths.

## Header and chat tab bar controls

The workspace header keeps the controls used on most visits inline: the project
and workspace switchers, the dev server control, the PR chip (with **Create PR**
next to it before a PR exists), and the right panel toggle. At 48rem and wider
the header also shows **Create PR** inline; at 72rem and wider it adds the issue
link, the dev server port and **Open in IDE**. A finished (done or merged)
workspace also shows **Archive** inline as its next step.

**More actions** (⋯) is always present. It holds View details, Rename workspace,
Provider settings, Open branch on GitHub, Open dev app and Archive workspace,
plus whichever of Create PR, the issue link and Open in IDE the header is not
showing inline. Inline wrappers carry `data-header-inline`, and the menu checks
which are visible when it opens, so Create PR, the issue and IDE actions do not
repeat. Archive deliberately remains in the menu even when a finished workspace
also offers it inline. Every icon-only control has an accessible name and a
tooltip.

The chat tab bar holds the chat tabs, closed chats, **New session** and a **Chat
actions** (⋮) menu with **Restart agent** for the selected chat. Quick actions
live only in the composer's ⚡ menu, which can run an action in this chat or a
new one; see [quick actions](architecture/agent-runtime.md#quick-actions).

Check these in Storybook under **Navigation / AppHeader** (desktop, tablet,
phone, dark, and the More actions stories), **Workspace / WorkspacePrChip**,
**Workspace / ChatActionsMenu** and **Chat / Input / QuickActionsMenu**.
