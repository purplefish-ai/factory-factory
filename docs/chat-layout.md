# Workspace chat layout

The message viewport takes the remaining height above the composer. When the
user scrolls away from the latest messages, the **Scroll to bottom** control
occupies a nonshrinking row between the viewport and composer. Keeping this row
in normal layout flow makes it visible and clickable as multiline drafts,
attachments, permission prompts, and questions change the composer height. Tall
permission and question prompts scroll within the available composer height,
keeping the input and its controls reachable on narrow screens. Clicking it
returns to the latest messages and hides the row.

For local UI checks, open **Workspaces / ChatContent / Composer Height Changes**
in `pnpm storybook`. This story uses mock conversation messages and local
callbacks; it never sends messages or starts a session. Use its controls to add
attachments and show permission or question prompts, then enter a multiline
draft and scroll up and down.

Run the browser regressions with
`pnpm exec playwright test --config=playwright.chat.config.ts`. They start a
frontend-only Storybook server, stub the voice configuration read, and check
button hit-testing, composer growth and shrinkage, draft preservation, and
scrolling at 320px, 375px, and desktop widths.
