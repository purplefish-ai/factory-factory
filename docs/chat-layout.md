# Workspace chat layout

The message viewport takes the remaining height above the composer. When the
user scrolls away from the latest messages, the **Scroll to bottom** control
overlays the bottom of the message viewport, above the reserved thinking footer.
Showing it does not resize the viewport or reserve a separate row above the
composer. Only the button intercepts pointer input; the surrounding overlay
passes input through to the messages beneath it. The control stays inside the
viewport as multiline drafts, attachments, permission prompts, and questions
change the composer height. Tall permission and question prompts scroll within
the available composer height, keeping the input and its controls reachable on
narrow screens. Clicking the control returns to the latest messages and hides
the button.

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

The workspace header keeps the project and workspace switchers, dev server
control, PR chip and right panel toggle inline. **Create PR** is available when
the workspace has changes, the agent is idle, and the current branch has no open
PR, including after an earlier PR was merged or closed. At 48rem and wider this
action appears beside the chip; below that it is in More actions. At 72rem and
wider the header adds the issue link and dev server port. **Archive workspace**
is available in More actions at every width, including for finished workspaces.

**More actions** (⋯) is always present. It holds View details, Rename workspace,
Provider settings, Open branch on GitHub, Open dev app, Open in IDE and Archive
workspace, plus whichever of Create PR and the issue link the header is not
showing inline. Inline wrappers carry `data-header-inline`, and the menu checks
which are visible when it opens, so Create PR and the issue link do not repeat.
Open in IDE and Archive workspace are available only in this menu at every
width. Every icon-only control has an accessible name and a tooltip.

The chat tab bar holds the chat tabs, closed chats, **New session** and a **Chat
actions** (⋮) menu with **Rename chat** and **Restart agent** for the selected
chat. Quick actions live only in the composer's ⚡ menu, which can run an action
in this chat or a new one; see
[quick actions](architecture/agent-runtime.md#quick-actions).

Check these in Storybook under **Navigation / AppHeader** (desktop, tablet,
phone, dark, and the More actions stories), **Workspace / WorkspacePrChip**,
**Workspace / ChatActionsMenu** and **Chat / Input / QuickActionsMenu**.

## Chat names, setup and composer

Choose **Chat actions → Rename chat** to edit the selected chat's name beside
the tabs. Enter or leaving the input saves a trimmed name; Escape cancels. Empty
names retain the existing name. A failed save keeps the draft and exposes Retry
through Enter.

The conversation and composer use a centered column capped at 56rem. Multiline
drafts grow up to the smaller of 40% of the viewport height or 320px, then
scroll inside the input. Send has a filled primary control, and Stop exposes the
platform's modifier-period shortcut in its tooltip.

During workspace initialization, **View setup output** beside the progress
spinner opens the setup logs in the workspace tools panel. The archive dialog
explains that agents and processes stop, changes are committed and the worktree
is removed while the branch and chat history are retained.
