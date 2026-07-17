# File Mention Cursor Revalidation Design

## Problem

The chat and Kanban file-mention hooks open autocomplete from the textarea value and cursor position observed during an input change. Cursor-only movement does not trigger another input change, so selection can combine a stale stored `@` position with the textarea's current cursor position. That mismatched replacement range duplicates or truncates text.

## Design

Both selection handlers will derive the mention range from the textarea's live value and cursor position immediately before replacement. Selection is valid only when:

- scanning backward from the cursor finds an `@` before any whitespace;
- the `@` is at the start of the input or follows supported whitespace; and
- the cursor is at the end of the mention token, meaning the next character is absent or supported whitespace.

If validation fails, the handler closes the palette and clears its filter without changing the textarea or calling `onChange`. If validation succeeds, the handler uses the freshly derived `@` position for the replacement and cursor placement. The stored mention-start state becomes unnecessary and will be removed.

## Scope

The same change applies to `useFileMentions` and `useProjectFileMentions`. No palette, input component, query, or visual behavior changes are required, so UI screenshots are not applicable.

## Tests

Each hook will have focused jsdom hook tests covering:

- cursor moved before the active `@`;
- cursor moved into the middle of the active mention token;
- cursor unchanged at the end of a valid mention; and
- cursor moved to the end of another valid mention, proving the live `@` position is used.

