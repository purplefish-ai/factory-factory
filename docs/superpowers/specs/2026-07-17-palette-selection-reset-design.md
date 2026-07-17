# Palette Selection Reset Design

## Goal

Ensure reopening a chat autocomplete palette starts keyboard selection at the first item even when its filter is unchanged.

## Root Cause

`usePaletteKeyboardNavigation` resets its state only when `resetKey` changes while the palette is open. Closing and reopening a palette with the same filter leaves both `selectedIndex` and the imperative `selectedIndexRef` at the previously highlighted item, so an immediate Enter selects stale state.

## Design

Track the previous `isOpen` and `resetKey` values in refs inside the existing `[isOpen, resetKey]` effect. Reset both the rendered state and imperative ref when the palette has just opened or when the reset key changes while open. Updating both refs on every effect run makes the transitions explicit and satisfies exhaustive-dependency checks.

This keeps the shared behavior consistent for slash-command and file-mention palettes. Initial-open behavior remains unchanged because selection already initializes to zero. Ordinary rerenders while open do not reset active navigation.

## Alternatives Considered

1. Track previous open and filter values explicitly. Selected because it distinguishes the exact opening and filter-change transitions while keeping both dependency values observable in the effect.
2. Reset whenever the palette closes. Rejected because the requirement is tied to a new interaction opening, and updating selection during the closed state is indirect.
3. Reset whenever the `[isOpen, resetKey]` effect runs while open. Rejected because `resetKey` would be a trigger-only dependency and fails the repository's exhaustive-dependency guardrail.

## Edge Cases

- Reopening with an empty or otherwise unchanged filter resets selection to index zero.
- Changing the filter while open continues to reset selection.
- Rerendering while still open and with the same filter preserves the current selection.
- The state value and ref used by imperative Enter/Tab handling reset together.
- Empty item lists retain existing passthrough behavior.

## Testing

Add a slash-command regression test that opens with an empty filter, navigates away from index zero, closes, reopens with the same filter, and immediately presses Enter. Assert that the first command is selected. Run the focused regression file before and after the implementation, followed by the repository's required typecheck, formatter, full test, and build commands.

## Scope

No component API, styling, screenshot, database, or backend changes are required.
